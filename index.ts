import * as aws from "@pulumi/aws";
import * as vpcBuilder from "@jen20/pulumi-aws-vpc";

import { BastionHost } from "./bastion";
import { ConsulServerCluster } from "./consul-cluster";
import { VaultCluster } from "./vault-cluster";
import { NomadServerCluster } from "./nomad-server-cluster";
import { NomadClientCluster } from "./nomad-client-cluster";

async function main() {
  const availabilityZones = await aws.getAvailabilityZones({
    state: "available",
  });

  const vpc = new vpcBuilder.Vpc("nomad", {
    description: "Nomad",
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

  const bastion = new BastionHost("bastion", {
    instanceType: "t2.micro",
    keypair: "karhu",
    vpcID: vpc.vpcId(),
    publicSubnetID: vpc.publicSubnetIds()[0],
    connectFromIPs: ["62.183.139.42/32", "82.128.138.172/32"],
  });

  // not for our demo
  // vpc.enableFlowLoggingToCloudWatchLogs("ALL");

  return {
    vpcId: vpc.vpcId(),
    publicSubnetIds: vpc.publicSubnetIds(),
    privateSubnetIds: vpc.privateSubnetIds(),
    bastionIp: bastion.publicIP(),
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
    vaultSecurityGroup: vault.securityGroup(),
    additionalSecurityGroups: [
      consul.clientSecurityGroupID(),
      "sg-0b9c74e28455f703a",
    ],
  });

  const nomadClients = new NomadClientCluster("nomad-client", {
    size: 1,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    subnets: ["subnet-1d198d45"],
    additionalSecurityGroups: [
      consul.clientSecurityGroupID(),
      nomadServers.clientSecurityGroupID(),
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

    nomadClientRole: nomadClients.roleArn(),
    nomadClientAsg: nomadClients.asgName(),
  };
}

// module.exports = justClusters();
module.exports = main();
