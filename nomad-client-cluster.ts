import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";
import { ListenerConfig, LoadBalancer } from "./loadbalancer";

export interface NomadClientClusterArgs {
  size: number;
  instanceType: string;

  vpcId: string | pulumi.Input<string>;
  subnets: pulumi.Input<string>[];
  additionalSecurityGroups: string[] | pulumi.Input<string>[];

  tags?: {
    [key: string]: string;
  };

  loadBalancer?: NomadLoadBalancerConfig;
}

export interface NomadLoadBalancerConfig {
  subnets: pulumi.Input<string>[];
  listeners: ListenerConfig[];
}

export class NomadClientCluster extends ComponentResource {
  private readonly name: string;
  private readonly conf: NomadClientClusterArgs;

  role: aws.iam.Role;
  serverAsg: aws.autoscaling.Group;
  machineSG: aws.ec2.SecurityGroup;
  loadBalancer?: LoadBalancer;

  constructor(
    name: string,
    args: NomadClientClusterArgs,
    opts?: ComponentResourceOptions
  ) {
    super("pondidum:aws-nomad-client-cluster", name, {}, opts);

    this.name = name;
    this.conf = args;

    this.role = this.createIamRole();
    this.machineSG = this.createSecurityGroup();

    const securityGroups = [
      this.machineSG.id,
      ...this.conf.additionalSecurityGroups,
    ];

    const targetGroups: pulumi.Output<string>[] = [];

    if (this.conf.loadBalancer) {
      this.loadBalancer = new LoadBalancer(
        this.name,
        Object.assign({}, this.conf.loadBalancer, { vpcId: this.conf.vpcId }),
        {
          parent: this,
        }
      );

      securityGroups.push(this.loadBalancer.targetSecurityGroup());
      targetGroups.push(...this.loadBalancer.targetGroups());
    }

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
        imageId: this.getAmi(),
        instanceType: this.conf.instanceType,

        userData: this.machineUserData(),

        iamInstanceProfile: profile,
        keyName: "karhu",
        securityGroups: securityGroups,

        rootBlockDevice: {
          volumeType: "standard",
          volumeSize: 50,
          deleteOnTermination: true,
        },
      },
      { parent: this }
    );

    const tags = Object.entries(this.conf.tags || {}).map(([k, v]) => ({
      key: k,
      value: v,
      propagateAtLaunch: true,
    }));

    this.serverAsg = new aws.autoscaling.Group(
      `${this.name}-asg`,
      {
        launchConfiguration: lc,

        vpcZoneIdentifiers: this.conf.subnets,

        desiredCapacity: this.conf.size,
        minSize: this.conf.size,
        maxSize: this.conf.size,

        targetGroupArns: targetGroups,

        tags: [
          { key: "Name", value: this.name, propagateAtLaunch: true },
          ...tags,
        ],
      },
      { parent: this }
    );
  }

  private machineUserData() {
    return pulumi.interpolate`#!/bin/bash
set -euo pipefail

export VAULT_ADDR=$(/opt/vault/bin/find-vault)

vault login -method=aws role="nomad-client"

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

/opt/nomad/bin/generate-client-meta

/opt/nomad/bin/run-nomad \
  --client \
  --gossip-encryption-key "$(/opt/vault/bin/gossip-key --for nomad)"
`;
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

  private createSecurityGroup() {
    const clientGroup = new aws.ec2.SecurityGroup(
      `${this.name}-client-sg`,
      {
        namePrefix: this.name,
        description: "nomad client",
        vpcId: this.conf.vpcId,

        egress: [
          { fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] },
        ],
      },
      { parent: this }
    );

    return clientGroup;
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

    const findinstances = new aws.iam.RolePolicy(
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
    return this.serverAsg.name;
  }

  public loadBalancerDnsName(): pulumi.Output<string> {
    return this.loadBalancer ? this.loadBalancer.dnsName() : pulumi.output("");
  }
}
