import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";

type SecurityGroupIngress = aws.types.input.ec2.SecurityGroupIngress;

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
  group: pulumi.Output<string>,
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
