import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";

export interface VaultClusterArgs {
  size: number;
  instanceType: string;

  subnets: string[];
  additionalSecurityGroups?: string[] | pulumi.Input<string>[];
}

export class VaultCluster extends ComponentResource {
  private readonly name: string;
  private readonly clusterSize: number;
  private readonly instanceType: string;

  private readonly subnets: string[];
  private readonly additionalSecurityGroups: string[] | pulumi.Input<string>[];

  private readonly bucket: aws.s3.Bucket;
  private readonly kms: aws.kms.Key;

  role: aws.iam.Role;
  profile: aws.iam.InstanceProfile;
  dynamo: aws.dynamodb.Table;

  constructor(
    name: string,
    args: VaultClusterArgs,
    opts?: ComponentResourceOptions
  ) {
    super("pondidum:aws-vault-cluster", name, {}, opts);

    this.name = name;
    this.clusterSize = args.size;
    this.instanceType = args.instanceType;

    this.subnets = args.subnets;
    this.additionalSecurityGroups = args.additionalSecurityGroups || [];

    this.bucket = new aws.s3.Bucket(
      "vault",
      {
        forceDestroy: true, // FOR NOW
        acl: "private",
      },
      { parent: this }
    );

    this.kms = new aws.kms.Key(
      "vault",
      {
        description: "vault unseal key",
        deletionWindowInDays: 10,
      },
      { parent: this }
    );

    this.dynamo = new aws.dynamodb.Table(
      "vault",
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

    const sg = this.createSecurityGroup();

    const ami = pulumi.output(
      aws.getAmi(
        {
          mostRecent: true,
          nameRegex: "vault-.*",
          owners: ["self"],
        },
        { async: true }
      )
    );

    this.role = this.createIamRole();
    this.profile = new aws.iam.InstanceProfile(
      "vault",
      {
        namePrefix: this.name,
        path: "/",
        role: this.role,
      },
      { parent: this.role }
    );

    const lc = new aws.ec2.LaunchConfiguration(
      "vault",
      {
        namePrefix: this.name,
        imageId: ami.imageId,
        instanceType: this.instanceType,

        userData: pulumi.interpolate`#!/bin/bash
set -euo pipefail

/opt/vault/bin/update-certificate \
  --vault-role "vault-server" \
  --cert-name "vault" \
  --common-name "vault.service.consul" || true

/opt/consul/bin/run-consul \
  --user vault \
  --client \
  --cluster-tag-key "consul-servers" \
  --cluster-tag-value "auto-join" \
  --enable-gossip-encryption \
  --gossip-encryption-key "$(/opt/consul/bin/gossip-key --vault-role vault-server)" \
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
      "vault",
      {
        launchConfiguration: lc,
        vpcZoneIdentifiers: this.subnets,

        desiredCapacity: this.clusterSize,
        minSize: this.clusterSize,
        maxSize: this.clusterSize,
        tags: [{ key: "Name", value: this.name, propagateAtLaunch: true }],
      },
      { parent: this }
    );
  }

  private createSecurityGroup() {
    const subnet = aws.ec2.getSubnet({ id: this.subnets[0] });

    const clusterPort = 8201;
    const apiPort = 8200;

    const group = new aws.ec2.SecurityGroup(
      "vault",
      {
        namePrefix: this.name,
        description: "vault server",

        ingress: [
          {
            description: "cluster",
            fromPort: clusterPort,
            toPort: clusterPort,
            protocol: "tcp",
            self: true,
          },
          {
            description: "api",
            fromPort: apiPort,
            toPort: apiPort,
            protocol: "tcp",
            self: true,
          },
          {
            description: "api",
            fromPort: apiPort,
            toPort: apiPort,
            protocol: "tcp",
            cidrBlocks: [subnet.then((x) => x.cidrBlock)],
          },
        ],

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
      "vault",
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
      "vault:s3",
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
      "vault:kms",
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
      "vault:iam",
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
      "vault:dynamo",
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
}
