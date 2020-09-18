import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";
import {
  self,
  tcpFromGroup,
  udpFromGroup,
  allTraffic,
  vpcTraffic,
} from "./security";

export interface NomadServerClusterArgs {
  size: number;
  instanceType: string;

  vpcId: string | pulumi.Input<string>;
  subnets: pulumi.Input<string>[];
  additionalSecurityGroups: string[] | pulumi.Input<string>[];
}

export class NomadServerCluster extends ComponentResource {
  private readonly name: string;
  private readonly conf: NomadServerClusterArgs;

  role: aws.iam.Role;
  serverAsg: aws.autoscaling.Group;
  clientSecurityGroup: aws.ec2.SecurityGroup;
  clientRole: aws.iam.Role;

  constructor(
    name: string,
    args: NomadServerClusterArgs,
    opts?: ComponentResourceOptions
  ) {
    super("pondidum:aws-nomad-server-cluster", name, {}, opts);

    this.name = name;
    this.conf = args;

    this.role = this.createIamRole();
    this.clientRole = this.createClientRole();

    const ami = this.getAmi();
    const clientSG = this.createClientSecurityGroup();
    const serverSG = this.createServerSecurityGroup(clientSG);

    this.serverAsg = this.createServerCluster(ami, clientSG, serverSG);

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
        instanceType: this.conf.instanceType,

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
  --num-servers ${this.conf.size} \
  --gossip-encryption-key "$(/opt/vault/bin/gossip-key --for nomad)" \
  --environment "VAULT_TOKEN=\"$(cat ~/.vault-token)\""
`,

        iamInstanceProfile: profile,
        keyName: "karhu",
        securityGroups: [
          serverSG.id,
          clientSG.id,
          ...this.conf.additionalSecurityGroups,
        ],

        rootBlockDevice: {
          volumeType: "standard",
          volumeSize: 50,
          deleteOnTermination: true,
        },

        //ebsBlockDevices: []
      },
      { parent: this }
    );

    return new aws.autoscaling.Group(
      `${this.name}-asg`,
      {
        launchConfiguration: lc,

        vpcZoneIdentifiers: this.conf.subnets,

        desiredCapacity: this.conf.size,
        minSize: this.conf.size,
        maxSize: this.conf.size,

        tags: [
          {
            key: "Name",
            value: this.name,
            propagateAtLaunch: true,
          },
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

  private createClientSecurityGroup() {
    const clientGroup = new aws.ec2.SecurityGroup(
      `${this.name}-client-sg`,
      {
        name: `${this.name}-client-member`,
        description: "connect to the nomad cluster",
        vpcId: this.conf.vpcId,
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
      `${this.name}-server-sg`,
      {
        name: `${this.name}-cluster`,
        description: "nomad server",
        vpcId: this.conf.vpcId,

        ingress: [
          tcpFromGroup(httpPort, clientGroup.id, "http api from clients"),
          tcpFromGroup(rpcPort, clientGroup.id, "rpc from clients"),
          tcpFromGroup(serfPort, clientGroup.id, "serf from clients"),
          udpFromGroup(serfPort, clientGroup.id, "serf from clients"),
          vpcTraffic(this.conf.subnets, "tcp", httpPort),

          self("tcp", serfPort, "serf lan"),
          self("udp", serfPort, "serf lan"),
        ],

        egress: [allTraffic()],
      },
      { parent: this }
    );

    return sg;
  }

  private createClientRole() {
    const role = new aws.iam.Role(
      `${this.name}-client-iam-role`,
      {
        namePrefix: `${this.name}-client`,
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
      `${this.name}-client-iam-policy-cluster`,
      {
        namePrefix: `${this.name}-client`,
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

  public clientRoleArn(): pulumi.Output<string> {
    return this.clientRole.arn;
  }

  public clientRoleName(): pulumi.Output<string> {
    return this.clientRole.name;
  }

  public asgName(): pulumi.Output<string> {
    return this.serverAsg.name;
  }

  public clientSecurityGroupID(): pulumi.Output<string> {
    return this.clientSecurityGroup.id;
  }
}
