import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";

type SecurityGroupIngress = aws.types.input.ec2.SecurityGroupIngress;
type SecurityGroupEgress = aws.types.input.ec2.SecurityGroupEgress;

export function tcp(port: number, desc: string): SecurityGroupIngress {
  return {
    description: desc,
    fromPort: port,
    toPort: port,
    protocol: "tcp",
    self: true,
  };
}
export function udp(port: number, desc: string): SecurityGroupIngress {
  return {
    description: desc,
    fromPort: port,
    toPort: port,
    protocol: "udp",
    self: true,
  };
}

export function tcpFromGroup(
  port: number,
  group: pulumi.Output<string> | string,
  desc: string
): SecurityGroupIngress {
  return {
    description: desc,
    fromPort: port,
    toPort: port,
    protocol: "tcp",
    securityGroups: [group],
  };
}

export function udpFromGroup(
  port: number,
  group: pulumi.Output<string>,
  desc: string
): SecurityGroupIngress {
  return {
    description: desc,
    fromPort: port,
    toPort: port,
    protocol: "udp",
    securityGroups: [group],
  };
}

export function allTraffic(): SecurityGroupIngress {
  return { fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] };
}

export function vpcTraffic(
  subnets: pulumi.Input<string>[],
  protocol: string
): SecurityGroupIngress {
  const cidrs = pulumi
    .all(subnets)
    .apply((sn) =>
      sn.map((id) => aws.ec2.getSubnet({ id: id }).then((s) => s.cidrBlock))
    );

  return {
    description: `All ${protocol} traffic in VPC`,
    protocol: protocol,
    fromPort: 0,
    toPort: 65535,
    cidrBlocks: cidrs,
  };
}
