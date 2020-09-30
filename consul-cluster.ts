import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";
import { self, allTraffic, vpcTraffic } from "./security";

const httpApiPort = 8500;
const serverRpc = 8300;
const serfLanPort = 8301;

export interface ConsulServerClusterArgs {
  size: number;
  instanceType: string;
  keypair: string | pulumi.Input<string>;

  vpcId: string | pulumi.Input<string>;
  subnets: pulumi.Input<string>[];
  additionalSecurityGroups: string[] | pulumi.Input<string>[];
}

export class ConsulServerCluster extends ComponentResource {
  private readonly name: string;
  private readonly conf: ConsulServerClusterArgs;

  role: aws.iam.Role;
  asg: aws.autoscaling.Group;
  gossipSG: aws.ec2.SecurityGroup;

  constructor(
    name: string,
    args: ConsulServerClusterArgs,
    opts?: ComponentResourceOptions
  ) {
    super("pondidum:aws-consul-cluster", name, {}, opts);

    this.name = name;
    this.conf = args;

    this.role = this.createIamRole();

    const ami = this.getAmi();
    const serverSG = this.createServerSecurityGroup();
    const gossipSG = this.createGossipSecurityGroup();

    this.asg = this.createServerCluster(ami, serverSG, gossipSG);
    this.gossipSG = gossipSG;
  }

  private createServerCluster(
    ami: pulumi.Output<string>,
    serverSG: aws.ec2.SecurityGroup,
    gossipSG: aws.ec2.SecurityGroup
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
        instanceType: this.conf.instanceType,
        userData: pulumi.interpolate`#!/bin/bash
set -euo pipefail

export VAULT_ADDR=$(/opt/vault/bin/find-vault)

vault login -method=aws role="consul-server"

# if this fails, we are still in initialisation phase
/opt/vault/bin/generate-certificate \
  --tls-dir "/opt/consul/tls" \
  --cert-name "consul" \
  --common-name "consul.service.consul" \
  --auto-refresh \
  --vault-role "consul-server"

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
        keyName: this.conf.keypair,
        securityGroups: [
          serverSG.id,
          gossipSG.id,
          ...this.conf.additionalSecurityGroups,
        ],

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

        vpcZoneIdentifiers: this.conf.subnets,

        desiredCapacity: this.conf.size,
        minSize: this.conf.size,
        maxSize: this.conf.size,

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

  private createGossipSecurityGroup() {
    return new aws.ec2.SecurityGroup(
      `${this.name}-gossip-sg`,
      {
        name: `${this.name}-gossip-member`,
        description: "consul gossip member",
        vpcId: this.conf.vpcId,

        ingress: [
          self("tcp", serfLanPort, "consul serf lan"),
          self("udp", serfLanPort, "consul serf lan"),
        ],
      },
      { parent: this }
    );
  }

  private createServerSecurityGroup() {
    const servers = new aws.ec2.SecurityGroup(
      `${this.name}-server-sg`,
      {
        name: `${this.name}-cluster`,
        description: "consul server",
        vpcId: this.conf.vpcId,

        ingress: [
          vpcTraffic(this.conf.subnets, "tcp", httpApiPort),
          vpcTraffic(this.conf.subnets, "tcp", serverRpc),

          self("tcp", serverRpc, "server rpc"),
          self("tcp", 8400, "cli rpc"),
          self("tcp", 8302, "serf wan"),
          self("udp", 8302, "serf wan"),
          self("tcp", httpApiPort, "http api"),
          self("tcp", 8600, "dns"),
          self("udp", 8600, "dns"),
        ],

        egress: [allTraffic()],
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

  public gossipTraffic(): pulumi.Output<string> {
    return this.gossipSG.id;
  }

  public roleArn(): pulumi.Output<string> {
    return this.role.arn;
  }

  public asgName(): pulumi.Output<string> {
    return this.asg.name;
  }
}
