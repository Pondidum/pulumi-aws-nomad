import * as aws from "@pulumi/aws";
import * as vpcBuilder from "@jen20/pulumi-aws-vpc";

import { ConsulServerCluster } from "./consul-cluster";
import { VaultCluster } from "./vault-cluster";
import { NomadServerCluster } from "./nomad-server-cluster";

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

function justClusters() {
  const consul = new ConsulServerCluster("consul", {
    size: 3,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    subnets: ["subnet-1d198d45"],
    additionalSecurityGroups: ["sg-0b9c74e28455f703a"],
  });

  const vault = new VaultCluster("vault", {
    size: 3,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    subnets: ["subnet-1d198d45"],
    additionalSecurityGroups: [
      consul.clientSecurityGroupID(),
      "sg-0b9c74e28455f703a",
    ],
  });

  const nomadServers = new NomadServerCluster("nomad", {
    size: 3,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    subnets: ["subnet-1d198d45"],
    additionalSecurityGroups: [
      consul.clientSecurityGroupID(),
      "sg-0b9c74e28455f703a",
    ],
  });

  return {
    vaultRole: vault.roleArn(),
    vaultAsg: vault.asgName(),

    consulRole: consul.roleArn(),
    consulAsg: consul.asgName(),

    nomadServerRole: nomadServers.roleArn(),
    nomadServerAsg: nomadServers.asgName(),
  };
}

module.exports = justClusters();
