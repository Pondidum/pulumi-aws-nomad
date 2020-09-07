import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";
import { tcp, udp, tcpFromGroup, udpFromGroup } from "./security";

const httpApiPort = 8500;
const serverRpc = 8300;
const serfLanPort = 8301;

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

    const ami = this.getAmi();
    const clientSG = this.createClientSecurityGroup();
    const serverSG = this.createServerSecurityGroup(clientSG);

    this.asg = this.createServerCluster(ami, clientSG, serverSG);

    this.clientSecurityGroup = clientSG;
  }

  private createServerCluster(
    ami: pulumi.Output<string>,
    clientSG: aws.ec2.SecurityGroup,
    serverSG: aws.ec2.SecurityGroup
  ): aws.autoscaling.Group {
    const profile = new aws.iam.InstanceProfile(
      `${this.name}-profile`,
      {
        namePrefix: this.name,
        path: "/",
        role: this.role,
      },
      { parent: this }
    );

    const lc = new aws.ec2.LaunchConfiguration(
      `${this.name}-launch-config`,
      {
        namePrefix: this.name,
        imageId: ami,
        instanceType: this.instanceType,
        userData: pulumi.interpolate`#!/bin/bash
set -euo pipefail

export VAULT_ADDR=$(/opt/vault/bin/find-vault)

vault login -method=aws role="consul-server"

# if this fails, we are still in initialisation phase
/opt/vault/bin/generate-certificate \
  --tls-dir "/opt/consul/tls" \
  --cert-name "consul" \
  --common-name "consul.service.consul"

/opt/consul/bin/run-consul \
  --server \
  --cluster-tag-key "consul-servers" \
  --cluster-tag-value "auto-join" \
  --enable-gossip-encryption \
  --gossip-encryption-key "$(/opt/vault/bin/gossip-key --for consul)" \
  --enable-rpc-encryption \
  --ca-path "/opt/consul/tls/ca/ca.crt.pem" \
  --cert-file-path "/opt/consul/tls/consul.crt.pem" \
  --key-file-path "/opt/consul/tls/consul.key.pem"
`,

        iamInstanceProfile: profile,
        keyName: "karhu",
        securityGroups: [
          serverSG.id,
          clientSG.id,
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

    const asg = new aws.autoscaling.Group(
      `${this.name}-asg`,
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

    return asg;
  }

  private getAmi(): pulumi.Output<string> {
    const ami = aws.getAmi(
      {
        mostRecent: true,
        nameRegex: "consul-.*",
        owners: ["self"],
      },
      { async: true }
    );

    return pulumi.output(ami).imageId;
  }

  private createClientSecurityGroup() {
    return new aws.ec2.SecurityGroup(
      `${this.name}-client-sg`,
      {
        namePrefix: this.name + "-client",
        description: "connect to the consul cluster",
        ingress: [tcp(serfLanPort, "serf lan"), udp(serfLanPort, "serf lan")],
      },
      { parent: this }
    );
  }

  private createServerSecurityGroup(clientGroup: aws.ec2.SecurityGroup) {
    const servers = new aws.ec2.SecurityGroup(
      `${this.name}-server-sg`,
      {
        namePrefix: this.name,
        description: "consul server",

        ingress: [
          tcpFromGroup(httpApiPort, clientGroup.id, "http api from clients"),
          tcpFromGroup(serverRpc, clientGroup.id, "server rpc from clients"),
          tcpFromGroup(serfLanPort, clientGroup.id, "serf lan from clients"),
          udpFromGroup(serfLanPort, clientGroup.id, "serf lan from clients"),

          tcp(serverRpc, "server rpc"),
          tcp(8400, "cli rpc"),
          tcp(serfLanPort, "serf lan"),
          udp(serfLanPort, "serf lan"),
          tcp(8302, "serf wan"),
          udp(8302, "serf wan"),
          tcp(httpApiPort, "http api"),
          tcp(8600, "dns"),
          udp(8600, "dns"),
        ],

        egress: [
          { fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] },
        ],
      },
      { parent: this }
    );

    return servers;
  }

  private createIamRole() {
    const role = new aws.iam.Role(
      `${this.name}-iam-role`,
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
      `${this.name}-iam-policy-cluster`,
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
