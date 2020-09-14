import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";

export interface NomadClientClusterArgs {
  size: number;
  instanceType: string;

  vpcId: string | pulumi.Input<string>;
  subnets: pulumi.Input<string>[];
  additionalSecurityGroups: string[] | pulumi.Input<string>[];

  tags?: {
    [key: string]: string;
  };
}

export class NomadClientCluster extends ComponentResource {
  private readonly name: string;
  private readonly conf: NomadClientClusterArgs;

  role: aws.iam.Role;
  serverAsg: aws.autoscaling.Group;
  target: aws.lb.TargetGroup;
  machineSG: aws.ec2.SecurityGroup;

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
    const ami = this.getAmi();

    this.target = this.createTargetGroup();
    this.serverAsg = this.createClientCluster(ami, this.machineSG, this.target);
  }

  private createTargetGroup() {
    return new aws.lb.TargetGroup(
      `${this.name}-target-group`,
      {
        namePrefix: this.name.substr(0, this.name.indexOf("-")),
        vpcId: this.conf.vpcId,
        targetType: "instance",
        port: 80,
        protocol: "HTTP",
      },
      { parent: this }
    );
  }

  private createClientCluster(
    ami: pulumi.Output<string>,
    sg: aws.ec2.SecurityGroup,
    target: aws.lb.TargetGroup
  ) {
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

/opt/nomad/bin/run-nomad \
  --client \
  --gossip-encryption-key "$(/opt/vault/bin/gossip-key --for nomad)"
`,

        iamInstanceProfile: profile,
        keyName: "karhu",
        securityGroups: [sg.id, ...this.conf.additionalSecurityGroups],

        rootBlockDevice: {
          volumeType: "standard",
          volumeSize: 50,
          deleteOnTermination: true,
        },

        //ebsBlockDevices: []
      },
      { parent: this }
    );

    const tags = Object.entries(this.conf.tags || {}).map(([k, v]) => ({
      key: k,
      value: v,
      propagateAtLaunch: true,
    }));

    return new aws.autoscaling.Group(
      `${this.name}-asg`,
      {
        launchConfiguration: lc,

        vpcZoneIdentifiers: this.conf.subnets,

        desiredCapacity: this.conf.size,
        minSize: this.conf.size,
        maxSize: this.conf.size,

        targetGroupArns: [target.arn],

        tags: [
          { key: "Name", value: this.name, propagateAtLaunch: true },
          ...tags,
        ],
      },
      { parent: this }
    );
  }

  withLoadBalancer(publicSubnets: pulumi.Input<string>[]) {
    const sg = new aws.ec2.SecurityGroup(
      `${this.name}-lb-sg`,
      {
        description: "Traffic to Loadbalancer",
        vpcId: this.conf.vpcId,

        ingress: [
          {
            protocol: "tcp",
            toPort: 80,
            fromPort: 80,
            cidrBlocks: ["0.0.0.0/0"],
          },
        ],

        egress: [
          { fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] },
        ],
      },
      { parent: this }
    );

    new aws.ec2.SecurityGroupRule(
      `${this.name}-lb-sg-to-ec2`,
      {
        description: "Traffic from LB to Nomad-Clients",
        type: "ingress",
        protocol: "tcp",
        fromPort: 80,
        toPort: 80,
        sourceSecurityGroupId: sg.id,
        securityGroupId: this.machineSG.id,
      },
      { parent: this }
    );

    const lb = new aws.lb.LoadBalancer(
      `${this.name}-lb`,
      {
        name: this.name,
        // namePrefix: this.name.substr(0, this.name.indexOf("-")),
        subnets: publicSubnets,
        securityGroups: [sg.id],
      },
      { parent: this }
    );

    const listener = new aws.lb.Listener(
      `${this.name}-lb-listener`,
      {
        loadBalancerArn: lb.arn,
        port: 80,
        protocol: "HTTP",
        defaultActions: [
          {
            type: "forward",
            targetGroupArn: this.target.arn,
          },
        ],
      },
      { parent: this }
    );

    return lb.dnsName;
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
        namePrefix: this.name + "-client",
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
}
