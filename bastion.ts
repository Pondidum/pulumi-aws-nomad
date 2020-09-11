import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";
import { tcpFromGroup } from "./security";

export interface BastionArgs {
  keypair: string;
  instanceType: aws.ec2.InstanceType;
  vpcID: string | Promise<string> | pulumi.Input<string> | undefined;
  publicSubnetID: string | pulumi.Input<string>;
  connectFromIPs: string[];
}

export class BastionHost extends ComponentResource {
  private readonly name: string;
  private readonly conf: BastionArgs;

  bastionSG: aws.ec2.SecurityGroup;
  targetSG: aws.ec2.SecurityGroup;
  machine: aws.ec2.Instance;

  constructor(
    name: string,
    args: BastionArgs,
    opts?: ComponentResourceOptions
  ) {
    super("pondidum:bastion", name, {}, opts);

    this.name = name;
    this.conf = args;

    this.bastionSG = this.createSecurityGroup();
    this.targetSG = this.createTargetSecurityGroup(this.bastionSG);

    this.machine = this.createMachine();
  }

  private createTargetSecurityGroup(bastionSG: aws.ec2.SecurityGroup) {
    return new aws.ec2.SecurityGroup(
      `${this.name}-sg-from-bastion`,
      {
        namePrefix: this.name,
        description: "SSH from Bastion",

        vpcId: this.conf.vpcID,
        ingress: [tcpFromGroup(22, bastionSG.id, "SSH from bastion")],
      },
      { parent: this }
    );
  }

  private createSecurityGroup() {
    return new aws.ec2.SecurityGroup(
      `${this.name}-sg`,
      {
        namePrefix: this.name,
        description: "Bastion",
        vpcId: this.conf.vpcID,
        ingress: [
          {
            description: "ssh",
            protocol: "tcp",
            fromPort: 22,
            toPort: 22,
            cidrBlocks: this.conf.connectFromIPs,
          },
        ],
      },
      { parent: this }
    );
  }

  private getAmi() {
    const ami = aws.getAmi(
      {
        mostRecent: true,
        owners: ["099720109477"], // canonical
        filters: [
          {
            name: "name",
            values: [
              "ubuntu/images/hvm-ssd/ubuntu-xenial-16.04-amd64-server-*",
            ],
          },
          { name: "virtualization-type", values: ["hvm"] },
        ],
      },
      { async: true }
    );

    return pulumi.output(ami).imageId;
  }

  private createMachine() {
    const machine = new aws.ec2.Instance(
      `${this.name}-bastion`,
      {
        ami: this.getAmi(),
        instanceType: this.conf.instanceType,
        userData: pulumi.interpolate``,
        keyName: this.conf.keypair,

        associatePublicIpAddress: true,
        subnetId: this.conf.publicSubnetID,
        vpcSecurityGroupIds: [this.bastionSG.id],

        tags: {
          Name: "Bastion",
        },
      },
      { parent: this }
    );

    return machine;
  }

  publicIP() {
    return this.machine.publicIp;
  }

  publicDns() {
    return this.machine.publicDns;
  }

  sshFromBastion() {
    return this.targetSG.id;
  }
}
