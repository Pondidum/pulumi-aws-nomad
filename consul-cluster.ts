import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";

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

    const sg = this.createSecurityGroup();

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
  --gossip-encryption-key "$(/opt/consul/bin/gossip-key)"
`,

        iamInstanceProfile: profile,
        keyName: "karhu",
        securityGroups: [sg, ...this.additionalSecurityGroups],

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

  private createSecurityGroup() {
    const ports = [
      { port: 8300, type: "tcp", name: "server rpc" },
      { port: 8400, type: "tcp", name: "cli rpc" },
      { port: 8301, type: "tcp", name: "serf lan" },
      { port: 8301, type: "udp", name: "serf lan" },
      { port: 8302, type: "tcp", name: "serf wan" },
      { port: 8302, type: "udp", name: "serf wan" },
      { port: 8500, type: "tcp", name: "http api" },
      { port: 8600, type: "tcp", name: "dns" },
      { port: 8600, type: "udp", name: "dns" },
    ];

    const group = new aws.ec2.SecurityGroup(
      "consul",
      {
        namePrefix: this.name,
        description: "consul server",

        ingress: ports.map((p) => ({
          fromPort: p.port,
          toPort: p.port,
          protocol: p.type,
          self: true,
          description: p.name,
        })),

        egress: [
          { fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] },
        ],
      },
      { parent: this }
    );

    return group.id;
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
}
