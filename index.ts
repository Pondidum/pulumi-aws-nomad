import * as aws from "@pulumi/aws";
import * as vpcBuilder from "@jen20/pulumi-aws-vpc";

import { ConsulServerCluster } from "./consul-cluster";

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
  const consul = new ConsulServerCluster("consul", {
    size: 3,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    subnets: ["subnet-1d198d45"],
    additionalSecurityGroups: ["sg-0b9c74e28455f703a"],
  });
}

module.exports = consulCluster();
// module.exports = main();
