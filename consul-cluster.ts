import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";

type SecurityGroupIngress = aws.types.input.ec2.SecurityGroupIngress;

export interface ConsulServerClusterArgs {
  size: number;
  instanceType: string;

  subnets: string[];
  additionalSecurityGroups?: string[];
}

export class ConsulServerCluster extends ComponentResource {
  private readonly name: string;
  private readonly clusterSize: number;
  private readonly instanceType: string;

  private readonly subnets: string[];
  private readonly additionalSecurityGroups: string[];

  role: aws.iam.Role;
  clientSecurityGroup: aws.ec2.SecurityGroup;
  serverSecurityGroup: aws.ec2.SecurityGroup;
  asg: aws.autoscaling.Group;

  constructor(
    name: string,
    args: ConsulServerClusterArgs,
    opts?: ComponentResourceOptions
  ) {
    super("pondidum:aws-consul-cluster", name, {}, opts);

    this.name = name;
    this.clusterSize = args.size;
    this.instanceType = args.instanceType;

    this.subnets = args.subnets;
    this.additionalSecurityGroups = args.additionalSecurityGroups || [];

    this.role = this.createIamRole();

    const profile = new aws.iam.InstanceProfile(
      "consul",
      {
        namePrefix: this.name,
        path: "/",
        role: this.role,
      },
      { parent: this }
    );

    const groups = this.createSecurityGroups();
    this.clientSecurityGroup = groups.clients;
    this.serverSecurityGroup = groups.servers;

    const ami = pulumi.output(
      aws.getAmi(
        {
          mostRecent: true,
          nameRegex: "consul-.*",
          owners: ["self"],
        },
        { async: true }
      )
    );

    const lc = new aws.ec2.LaunchConfiguration(
      "consul",
      {
        namePrefix: this.name,
        imageId: ami.imageId,
        instanceType: this.instanceType,
        userData: pulumi.interpolate`#!/bin/bash
set -euo pipefail

# if this fails, we are still in initialisation phase
/opt/consul/bin/update-certificate \
  --vault-role "consul-server" \
  --cert-name "consul" \
  --common-name "consul.service.consul"

/opt/consul/bin/run-consul \
  --server \
  --cluster-tag-key "consul-servers" \
  --cluster-tag-value "auto-join" \
  --enable-gossip-encryption \
  --gossip-encryption-key "$(/opt/consul/bin/gossip-key --vault-role consul-server)" \
  --enable-rpc-encryption \
  --ca-path "/opt/consul/tls/ca/ca.crt.pem" \
  --cert-file-path "/opt/consul/tls/consul.crt.pem" \
  --key-file-path "/opt/consul/tls/consul.key.pem"
`,

        iamInstanceProfile: profile,
        keyName: "karhu",
        securityGroups: [
          this.serverSecurityGroup.id,
          this.clientSecurityGroup.id,
          ...this.additionalSecurityGroups,
        ],

        associatePublicIpAddress: true, //FOR NOW

        rootBlockDevice: {
          volumeType: "standard",
          volumeSize: 50,
          deleteOnTermination: true,
        },
      },
      { parent: this }
    );

    this.asg = new aws.autoscaling.Group(
      "consul",
      {
        launchConfiguration: lc,

        vpcZoneIdentifiers: this.subnets,

        desiredCapacity: this.clusterSize,
        minSize: this.clusterSize,
        maxSize: this.clusterSize,

        tags: [
          { key: "Name", value: this.name, propagateAtLaunch: true },
          {
            key: "consul-servers",
            value: "auto-join",
            propagateAtLaunch: true,
          },
        ],
      },
      { parent: this }
    );
  }

  private tcp(port: number, desc: string): SecurityGroupIngress {
    return {
      description: desc,
      fromPort: port,
      toPort: port,
      protocol: "tcp",
      self: true,
    };
  }
  private udp(port: number, desc: string): SecurityGroupIngress {
    return {
      description: desc,
      fromPort: port,
      toPort: port,
      protocol: "udp",
      self: true,
    };
  }

  private tcpFromGroup(
    port: number,
    group: pulumi.Output<string>,
    desc: string
  ): SecurityGroupIngress {
    return {
      description: desc,
      fromPort: port,
      toPort: port,
      protocol: "tcp",
      securityGroups: [group],
    };
  }

  private udpFromGroup(
    port: number,
    group: pulumi.Output<string>,
    desc: string
  ): SecurityGroupIngress {
    return {
      description: desc,
      fromPort: port,
      toPort: port,
      protocol: "udp",
      securityGroups: [group],
    };
  }

  private createSecurityGroups() {
    const httpApiPort = 8500;
    const serverRpc = 8300;
    const serfLanPort = 8301;

    const clients = new aws.ec2.SecurityGroup(
      "consul:client",
      {
        namePrefix: this.name + "-client",
        description: "connect to the consul cluster",
        ingress: [
          this.tcp(serfLanPort, "serf lan"),
          this.udp(serfLanPort, "serf lan"),
        ],
      },
      { parent: this }
    );

    const servers = new aws.ec2.SecurityGroup(
      "consul:server",
      {
        namePrefix: this.name,
        description: "consul server",

        ingress: [
          this.tcpFromGroup(httpApiPort, clients.id, "http api from clients"),
          this.tcpFromGroup(serverRpc, clients.id, "server rpc from clients"),
          this.tcpFromGroup(serfLanPort, clients.id, "serf lan from clients"),
          this.udpFromGroup(serfLanPort, clients.id, "serf lan from clients"),

          this.tcp(serverRpc, "server rpc"),
          this.tcp(8400, "cli rpc"),
          this.tcp(serfLanPort, "serf lan"),
          this.udp(serfLanPort, "serf lan"),
          this.tcp(8302, "serf wan"),
          this.udp(8302, "serf wan"),
          this.tcp(httpApiPort, "http api"),
          this.tcp(8600, "dns"),
          this.udp(8600, "dns"),
        ],

        egress: [
          { fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] },
        ],
      },
      { parent: this }
    );

    return { clients, servers };
    // this.clientSecurityGroup = clients;
    // this.serverSecurityGroup = servers;
  }

  private createIamRole() {
    const role = new aws.iam.Role(
      "consul",
      {
        namePrefix: this.name,
        assumeRolePolicy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["sts:AssumeRole"],
              Principal: { Service: "ec2.amazonaws.com" },
            },
          ],
        },
      },
      { parent: this }
    );

    const rolePolicy = new aws.iam.RolePolicy(
      "consul",
      {
        namePrefix: this.name,
        role: role,
        policy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Resource: "*",
              Action: [
                "ec2:DescribeInstances",
                "ec2:DescribeTags",
                "autoscaling:DescribeAutoScalingGroups",
              ],
            },
          ],
        },
      },
      { parent: this }
    );

    return role;
  }

  public roleArn(): pulumi.Output<string> {
    return this.role.arn;
  }

  public asgName(): pulumi.Output<string> {
    return this.asg.name;
  }

  public clientSecurityGroupID(): pulumi.Output<string> {
    return this.clientSecurityGroup.id;
  }
}
