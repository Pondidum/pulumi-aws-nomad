import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";
import { tcp, udp, tcpFromGroup, udpFromGroup } from "./security";

export interface NomadServerClusterArgs {
  size: number;
  instanceType: string;

  subnets: string[];
  additionalSecurityGroups?: string[] | pulumi.Input<string>[];
}

export class NomadServerCluster extends ComponentResource {
  private readonly name: string;
  private readonly clusterSize: number;
  private readonly instanceType: string;

  private readonly subnets: string[];
  private readonly additionalSecurityGroups: string[] | pulumi.Input<string>[];

  role: aws.iam.Role;
  clientSG: aws.ec2.SecurityGroup;
  serverSG: aws.ec2.SecurityGroup;
  asg: aws.autoscaling.Group;

  constructor(
    name: string,
    args: NomadServerClusterArgs,
    opts?: ComponentResourceOptions
  ) {
    super("pondidum:aws-nomad-server-cluster", name, {}, opts);

    this.name = name;
    this.clusterSize = args.size;
    this.instanceType = args.instanceType;

    this.subnets = args.subnets;
    this.additionalSecurityGroups = args.additionalSecurityGroups || [];

    this.role = this.createIamRole();

    const profile = new aws.iam.InstanceProfile(
      "nomad:server",
      {
        namePrefix: this.name,
        path: "/",
        role: this.role,
      },
      { parent: this }
    );

    this.clientSG = this.createClientSecurityGroup();
    this.serverSG = this.createServerSecurityGroup(this.clientSG);

    const lc = new aws.ec2.LaunchConfiguration(
      "nomad:server",
      {
        namePrefix: this.name,
        imageId: this.getAmi(),
        instanceType: this.instanceType,

        userData: pulumi.interpolate`#!/bin/bash
set -euo pipefail

export VAULT_ADDR=$(/opt/vault/bin/find-vault)

vault login -method=aws role="nomad-server"

# if this fails, we are still in initialisation phase
/opt/vault/bin/generate-certificate \
  --tls-dir "/opt/nomad/tls" \
  --cert-name "nomad" \
  --common-name "nomad.service.consul" || true

/opt/consul/bin/run-consul \
  --user nomad \
  --client \
  --cluster-tag-key "consul-servers" \
  --cluster-tag-value "auto-join" \
  --enable-gossip-encryption \
  --gossip-encryption-key "$(/opt/vault/bin/gossip-key --for consul)" \
  --enable-rpc-encryption \
  --ca-path "/opt/nomad/tls/ca.crt.pem" \
  --cert-file-path "/opt/nomad/tls/nomad.crt.pem" \
  --key-file-path "/opt/nomad/tls/nomad.key.pem" || true

/opt/nomad/bin/run-nomad \
  --server \
  --num-servers ${this.clusterSize} \
  --gossip-encryption-key "$(/opt/vault/bin/gossip-key --for nomad)" \
  --environment "VAULT_TOKEN=\"$(cat ~/.vault-token)\""
`,

        iamInstanceProfile: profile,
        keyName: "karhu",
        securityGroups: [
          this.serverSG.id,
          this.clientSG.id,
          ...this.additionalSecurityGroups,
        ],

        associatePublicIpAddress: true, // FOR NOW

        rootBlockDevice: {
          volumeType: "standard",
          volumeSize: 50,
          deleteOnTermination: true,
        },

        //ebsBlockDevices: []
      },
      { parent: this }
    );

    this.asg = new aws.autoscaling.Group(
      "nomad-server",
      {
        launchConfiguration: lc,

        vpcZoneIdentifiers: this.subnets,

        desiredCapacity: this.clusterSize,
        minSize: this.clusterSize,
        maxSize: this.clusterSize,

        tags: [
          { key: "Name", value: this.name, propagateAtLaunch: true },
          { key: "nomad-servers", value: "auto-join", propagateAtLaunch: true },
        ],
      },
      { parent: this }
    );
  }

  private getAmi(): pulumi.Output<string> {
    const ami = aws.getAmi(
      {
        mostRecent: true,
        nameRegex: "nomad-.*",
        owners: ["self"],
      },
      { async: true }
    );

    return pulumi.output(ami).imageId;
  }

  private createIamRole() {
    const role = new aws.iam.Role(
      "nomad:server",
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

    const findinstances = new aws.iam.RolePolicy(
      "nomad:server",
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

  private createClientSecurityGroup() {
    const serfPort = 4648;

    const clientGroup = new aws.ec2.SecurityGroup(
      "nomad:client",
      {
        namePrefix: this.name + "-client",
        description: "connect to the nomad cluster",
        ingress: [tcp(serfPort, "serf lan"), udp(serfPort, "serf lan")],
      },
      { parent: this }
    );

    return clientGroup;
  }

  private createServerSecurityGroup(clientGroup: aws.ec2.SecurityGroup) {
    const httpPort = 4646;
    const rpcPort = 4647;
    const serfPort = 4648;

    const sg = new aws.ec2.SecurityGroup(
      "nomad:server",
      {
        namePrefix: this.name,
        description: "nomad server",

        ingress: [
          tcpFromGroup(httpPort, clientGroup.id, "http api from clients"),
          tcpFromGroup(rpcPort, clientGroup.id, "rpc from clients"),
          tcpFromGroup(serfPort, clientGroup.id, "serf from clients"),
          udpFromGroup(serfPort, clientGroup.id, "serf from clients"),
        ],

        egress: [
          { fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] },
        ],
      },
      { parent: this }
    );

    return sg;
  }

  public roleArn(): pulumi.Output<string> {
    return this.role.arn;
  }

  public asgName(): pulumi.Output<string> {
    return this.asg.name;
  }
}
