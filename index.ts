import * as pulumi from "@pulumi/pulumi";
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

  const config = new pulumi.Config();
  const keypair = config.require("keypair");
  const sourceip = config.require("source-ip");

  const bastion = new BastionHost("bastion", {
    instanceType: "t2.micro",
    keypair: keypair,
    vpcID: vpc.vpcId(),
    publicSubnetID: vpc.publicSubnetIds()[0],
    connectFromIPs: [`${sourceip}/32`],
  });

  const consul = new ConsulServerCluster("consul", {
    size: 3,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    keypair: keypair,
    vpcId: vpc.vpcId(),
    subnets: vpc.privateSubnetIds(),
    additionalSecurityGroups: [bastion.sshFromBastion()],
  });

  const vault = new VaultCluster("vault", {
    size: 3,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    keypair: keypair,
    vpcId: vpc.vpcId(),
    subnets: vpc.privateSubnetIds(),
    additionalSecurityGroups: [
      bastion.sshFromBastion(),
      consul.gossipTraffic(),
    ],
  });

  const nomadServers = new NomadServerCluster("nomad", {
    size: 3,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    keypair: keypair,
    vpcId: vpc.vpcId(),
    subnets: vpc.privateSubnetIds(),
    additionalSecurityGroups: [
      bastion.sshFromBastion(),
      consul.gossipTraffic(),
    ],
  });

  const nomadClients = new NomadClientCluster("nomad-client", {
    size: 1,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    keypair: keypair,
    vpcId: vpc.vpcId(),
    subnets: vpc.privateSubnetIds(),
    additionalSecurityGroups: [
      bastion.sshFromBastion(),
      consul.gossipTraffic(),
      nomadServers.clientSecurityGroupID(),
    ],
    role: nomadServers.clientRoleName(),
  });

  const traefikClients = new NomadClientCluster("nomad-client-traefik", {
    size: 1,
    instanceType: aws.ec2.InstanceTypes.T2_Micro,
    keypair: keypair,
    vpcId: vpc.vpcId(),
    subnets: vpc.privateSubnetIds(),
    additionalSecurityGroups: [
      bastion.sshFromBastion(),
      consul.gossipTraffic(),
      nomadServers.clientSecurityGroupID(),
    ],
    role: nomadServers.clientRoleName(),
    tags: {
      traefik: "true",
    },
    loadBalancer: {
      subnets: vpc.publicSubnetIds(),
      listeners: [{ port: 80, protocol: "HTTP" }],
    },
  });

  return {
    vpcId: vpc.vpcId(),
    publicSubnetIds: vpc.publicSubnetIds(),
    privateSubnetIds: vpc.privateSubnetIds(),
    bastionIp: bastion.publicIP(),

    // setup script uses these
    vaultRole: vault.roleArn(),
    consulRole: consul.roleArn(),
    nomadServerRole: nomadServers.roleArn(),
    nomadClientRole: nomadServers.clientRoleArn(),

    nomadClientLb: traefikClients.loadBalancerDnsName(),
  };
}

module.exports = main();
