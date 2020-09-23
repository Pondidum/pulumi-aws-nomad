import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";
import { self, allTraffic, vpcTraffic } from "./security";

export interface VaultClusterArgs {
  size: number;
  instanceType: string;
  keypair: string | pulumi.Input<string>;

  vpcId: string | pulumi.Input<string>;
  subnets: pulumi.Input<string>[];
  additionalSecurityGroups: string[] | pulumi.Input<string>[];
}

export class VaultCluster extends ComponentResource {
  private readonly name: string;
  private readonly conf: VaultClusterArgs;

  private readonly bucket: aws.s3.Bucket;
  private readonly kms: aws.kms.Key;

  role: aws.iam.Role;
  profile: aws.iam.InstanceProfile;
  dynamo: aws.dynamodb.Table;
  asg: aws.autoscaling.Group;
  sg: aws.ec2.SecurityGroup;

  constructor(
    name: string,
    args: VaultClusterArgs,
    opts?: ComponentResourceOptions
  ) {
    super("pondidum:aws-vault-cluster", name, {}, opts);

    this.name = name;
    this.conf = args;

    this.bucket = this.createS3();
    this.kms = this.createKmsKey();
    this.dynamo = this.createDynamoDB();
    this.sg = this.createSecurityGroup();
    this.role = this.createIamRole();

    this.profile = new aws.iam.InstanceProfile(
      `${this.name}-profile`,
      {
        namePrefix: this.name,
        path: "/",
        role: this.role,
      },
      { parent: this.role }
    );

    const lc = new aws.ec2.LaunchConfiguration(
      `${this.name}-launch-config`,
      {
        namePrefix: this.name,
        imageId: this.getAmi(),
        instanceType: this.conf.instanceType,

        userData: pulumi.interpolate`#!/bin/bash
set -euo pipefail

export VAULT_ADDR=$(/opt/vault/bin/find-vault) || true

vault login -method=aws role="vault-server"  || true

/opt/vault/bin/generate-certificate \
  --cert-name "vault" \
  --common-name "vault.service.consul" || true

/opt/consul/bin/run-consul \
  --user vault \
  --client \
  --cluster-tag-key "consul-servers" \
  --cluster-tag-value "auto-join" \
  --enable-gossip-encryption \
  --gossip-encryption-key "$(/opt/vault/bin/gossip-key --for consul)" \
  --enable-rpc-encryption \
  --ca-path "/opt/vault/tls/ca.crt.pem" \
  --cert-file-path "/opt/vault/tls/vault.crt.pem" \
  --key-file-path "/opt/vault/tls/vault.key.pem" || true

/opt/vault/bin/run-vault \
  --tls-cert-file "/opt/vault/tls/vault.crt.pem" \
  --tls-key-file "/opt/vault/tls/vault.key.pem" \
  --enable-s3-backend \
  --s3-bucket "${this.bucket.bucket}" \
  --s3-bucket-region "${aws.config.region}" \
  --enable-dynamo-backend \
  --dynamo-table "${this.dynamo.name}" \
  --dynamo-region "${aws.config.region}" \
  --enable-auto-unseal \
  --auto-unseal-kms-key-id "${this.kms.keyId}" \
  --auto-unseal-kms-key-region "${aws.config.region}"
`,

        iamInstanceProfile: this.profile,
        keyName: this.conf.keypair,
        securityGroups: [this.sg.id, ...this.conf.additionalSecurityGroups],

        rootBlockDevice: {
          volumeType: "standard",
          volumeSize: 50,
          deleteOnTermination: true,
        },
      },
      { parent: this }
    );

    this.asg = new aws.autoscaling.Group(
      `${this.name}-asg`,
      {
        launchConfiguration: lc,
        vpcZoneIdentifiers: this.conf.subnets,

        desiredCapacity: this.conf.size,
        minSize: this.conf.size,
        maxSize: this.conf.size,
        tags: [{ key: "Name", value: this.name, propagateAtLaunch: true }],
      },
      { parent: this }
    );
  }

  private getAmi(): pulumi.Output<string> {
    const ami = aws.getAmi(
      {
        mostRecent: true,
        nameRegex: "vault-.*",
        owners: ["self"],
      },
      { async: true }
    );

    return pulumi.output(ami).imageId;
  }

  private createDynamoDB() {
    return new aws.dynamodb.Table(
      `${this.name}-dynamo`,
      {
        attributes: [
          { name: "Path", type: "S" },
          { name: "Key", type: "S" },
        ],
        hashKey: "Path",
        rangeKey: "Key",
        readCapacity: 1,
        writeCapacity: 1,
      },
      { parent: this }
    );
  }

  private createKmsKey() {
    return new aws.kms.Key(
      `${this.name}-kms`,
      {
        description: "vault unseal key",
        deletionWindowInDays: 10,
      },
      { parent: this }
    );
  }

  private createS3() {
    return new aws.s3.Bucket(
      `${this.name}-bucket`,
      {
        forceDestroy: true, // FOR NOW
        acl: "private",
      },
      { parent: this }
    );
  }

  private createSecurityGroup() {
    const clusterPort = 8201;
    const apiPort = 8200;

    const group = new aws.ec2.SecurityGroup(
      `${this.name}-server-sg`,
      {
        name: `${this.name}-cluster`,
        description: "vault server",
        vpcId: this.conf.vpcId,

        ingress: [
          self("tcp", clusterPort, "cluster"),
          self("tcp", apiPort, "api"),
          vpcTraffic(this.conf.subnets, "tcp", apiPort),
        ],

        egress: [allTraffic()],
      },
      { parent: this }
    );

    return group;
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

    const s3Policy = new aws.iam.RolePolicy(
      `${this.name}-iam-policy-s3`,
      {
        namePrefix: this.name,
        role: role,
        policy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:*"],
              Resource: [
                this.bucket.arn,
                pulumi.interpolate`${this.bucket.arn}/*`,
              ],
            },
          ],
        },
      },
      { parent: role }
    );

    const kmsPolicy = new aws.iam.RolePolicy(
      `${this.name}-iam-policy-kms`,
      {
        namePrefix: this.name,
        role: role,
        policy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Resource: [this.kms.arn],
              Action: ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey"],
            },
          ],
        },
      },
      { parent: role }
    );

    const iamPolicy = new aws.iam.RolePolicy(
      `${this.name}-iam-policy-cluster`,
      {
        namePrefix: this.name,
        role: role,
        policy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Resource: ["*"],
              // Resource: ["arn:aws:iam::*:user/*", "arn:aws:iam::*:role/*"],
              Action: [
                "iam:GetInstanceProfile",
                "iam:GetRole",
                "iam:GetUser",
                "ec2:DescribeInstances",
              ],
            },
            {
              Effect: "Allow",
              Resource: ["*"],
              Action: ["sts:GetCallerIdentity"],
            },
          ],
        },
      },
      { parent: role }
    );

    const dynamoPolicy = new aws.iam.RolePolicy(
      `${this.name}-iam-policy-dynamo`,
      {
        namePrefix: this.name,
        role: role,
        policy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Resource: [this.dynamo.arn],
              Action: [
                "dynamodb:DescribeLimits",
                "dynamodb:DescribeTimeToLive",
                "dynamodb:ListTagsOfResource",
                "dynamodb:DescribeReservedCapacityOfferings",
                "dynamodb:DescribeReservedCapacity",
                "dynamodb:ListTables",
                "dynamodb:BatchGetItem",
                "dynamodb:BatchWriteItem",
                "dynamodb:CreateTable",
                "dynamodb:DeleteItem",
                "dynamodb:GetItem",
                "dynamodb:GetRecords",
                "dynamodb:PutItem",
                "dynamodb:Query",
                "dynamodb:UpdateItem",
                "dynamodb:Scan",
                "dynamodb:DescribeTable",
              ],
            },
          ],
        },
      },
      { parent: role }
    );

    return role;
  }

  public profileArn(): pulumi.Output<string> {
    return this.profile.arn;
  }

  public roleArn(): pulumi.Output<string> {
    return this.role.arn;
  }

  public asgName(): pulumi.Output<string> {
    return this.asg.name;
  }

  public securityGroup(): pulumi.Output<string> {
    return this.sg.id;
  }
}
