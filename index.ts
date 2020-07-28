import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as vpcBuilder from "@jen20/pulumi-aws-vpc";

async function main() {
  const availabilityZones = await aws.getAvailabilityZones({
    state: "available",
  });

  const vpc = new vpcBuilder.Vpc("nomad", {
    description: "Nomad Cluster",
    baseCidr: "192.168.0.0/16",
    availabilityZoneNames: availabilityZones.names,
    endpoints: {
      s3: true,
      dynamodb: false,
    },
    baseTags: {
      Project: "nomad-infra",
    },
  });

  // not for our demo
  // vpc.enableFlowLoggingToCloudWatchLogs("ALL");

  return {
    vpcId: vpc.vpcId(),
    publicSubnetIds: vpc.publicSubnetIds(),
    privateSubnetIds: vpc.privateSubnetIds(),
  };
}

async function consulCluster() {
  const clusterSize = 3;
  const clusterName = "consul-servers";

  const ami = await aws.getAmi({
    mostRecent: true,
    nameRegex: "consul-.*",
    owners: ["self"],
  });

  const role = new aws.iam.Role("consul", {
    namePrefix: clusterName,
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
  });

  const rolePolicy = new aws.iam.RolePolicy("consul", {
    namePrefix: clusterName,
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
  });

  const profile = new aws.iam.InstanceProfile("consul", {
    namePrefix: clusterName,
    path: "/",
    role: role,
  });

  const lcgroup = new aws.ec2.SecurityGroup("consul", {
    namePrefix: clusterName,
    description: "consul server",

    ingress: [
      {
        fromPort: 8300,
        toPort: 8300,
        protocol: "tcp",
        self: true,
        description: "server rpc port",
      },
      {
        fromPort: 8400,
        toPort: 8400,
        protocol: "tcp",
        self: true,
        description: "cli rpc port",
      },
      {
        fromPort: 8302,
        toPort: 8302,
        protocol: "tcp",
        self: true,
        description: "serf wan port",
      },
      {
        fromPort: 8302,
        toPort: 8302,
        protocol: "udp",
        self: true,
        description: "serf wan port (udp)",
      },
      {
        fromPort: 8301,
        toPort: 8301,
        protocol: "tcp",
        self: true,
        description: "serf lan port",
      },
      {
        fromPort: 8301,
        toPort: 8301,
        protocol: "udp",
        self: true,
        description: "serf lan port (udp)",
      },
      {
        fromPort: 8500,
        toPort: 8500,
        protocol: "tcp",
        self: true,
        description: "http api port",
      },
      {
        fromPort: 8600,
        toPort: 8600,
        protocol: "tcp",
        self: true,
        description: "dns port",
      },
      {
        fromPort: 8600,
        toPort: 8600,
        protocol: "udp",
        self: true,
        description: "dns port (udp)",
      },
    ],

    egress: [
      { fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] },
    ],
  });

  const lc = new aws.ec2.LaunchConfiguration("consul", {
    namePrefix: clusterName,
    imageId: ami.imageId,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    userData: `
#!/bin/bash
/opt/consul/bin/run-consul --server --cluster-tag-key "consul-servers" --cluster-tag-value "auto-join"`.trim(),

    iamInstanceProfile: profile,
    keyName: "karhu",
    securityGroups: [lcgroup.id, "sg-0b9c74e28455f703a"],

    associatePublicIpAddress: true, //FOR NOW

    rootBlockDevice: {
      volumeType: "standard",
      volumeSize: 50,
      deleteOnTermination: true,
    },
  });

  const asg = new aws.autoscaling.Group("consul", {
    launchConfiguration: lc,

    vpcZoneIdentifiers: ["subnet-1d198d45"],

    desiredCapacity: clusterSize,
    minSize: clusterSize,
    maxSize: clusterSize,

    tags: [
      { key: "Name", value: clusterName, propagateAtLaunch: true },
      { key: "consul-servers", value: "auto-join", propagateAtLaunch: true },
    ],
  });
}

module.exports = consulCluster();
// module.exports = main();
