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

  const lcgroup = new aws.ec2.SecurityGroup("consul", {
    namePrefix: clusterName,
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
