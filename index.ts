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

  // not for our demo
  // vpc.enableFlowLoggingToCloudWatchLogs("ALL");

  const bastion = new BastionHost("bastion", {
    instanceType: "t2.micro",
    keypair: "karhu",
    vpcID: vpc.vpcId(),
    publicSubnetID: vpc.publicSubnetIds()[0],
    connectFromIPs: ["62.183.139.42/32", "82.128.138.172/32"],
  });

  const consul = new ConsulServerCluster("consul", {
    size: 3,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    vpcId: vpc.vpcId(),
    subnets: vpc.privateSubnetIds(),
    additionalSecurityGroups: [bastion.sshFromBastion()],
  });

  const vault = new VaultCluster("vault", {
    size: 3,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    vpcId: vpc.vpcId(),
    subnets: vpc.privateSubnetIds(),
    additionalSecurityGroups: [
      consul.clientSecurityGroupID(),
      bastion.sshFromBastion(),
    ],
  });

  const nomadServers = new NomadServerCluster("nomad", {
    size: 3,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    vpcId: vpc.vpcId(),
    subnets: vpc.privateSubnetIds(),
    additionalSecurityGroups: [
      consul.clientSecurityGroupID(),
      bastion.sshFromBastion(),
    ],
  });

  const nomadClients = new NomadClientCluster("nomad-client", {
    size: 1,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    vpcId: vpc.vpcId(),
    subnets: vpc.privateSubnetIds(),
    additionalSecurityGroups: [
      consul.clientSecurityGroupID(),
      nomadServers.clientSecurityGroupID(),
      bastion.sshFromBastion(),
    ],
    tags: {
      traefik: "true",
    },
  });

  const lb = nomadClients.withLoadBalancer(vpc.publicSubnetIds());

  return {
    vpcId: vpc.vpcId(),
    publicSubnetIds: vpc.publicSubnetIds(),
    privateSubnetIds: vpc.privateSubnetIds(),
    bastionIp: bastion.publicIP(),

    vaultRole: vault.roleArn(),
    vaultAsg: vault.asgName(),

    consulRole: consul.roleArn(),
    consulAsg: consul.asgName(),

    nomadServerRole: nomadServers.roleArn(),
    nomadServerAsg: nomadServers.asgName(),

    nomadClientRole: nomadClients.roleArn(),
    nomadClientAsg: nomadClients.asgName(),
    nomadClientLb: lb,
  };
}

module.exports = main();
