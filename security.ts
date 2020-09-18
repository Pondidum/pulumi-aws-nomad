import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";

type SecurityGroupIngress = aws.types.input.ec2.SecurityGroupIngress;
type SecurityGroupEgress = aws.types.input.ec2.SecurityGroupEgress;

export function self(
  protocol: string,
  port: number,
  desc: string
): SecurityGroupIngress {
  return {
    description: desc,
    fromPort: port,
    toPort: port,
    protocol: protocol,
    self: true,
  };
}

export function tcp(port: number, desc: string): SecurityGroupIngress {
  return self("tcp", port, desc);
}
export function udp(port: number, desc: string): SecurityGroupIngress {
  return self("udp", port, desc);
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
  protocol: string,
  port?: number
): SecurityGroupIngress {
  const cidrs = pulumi
    .all(subnets)
    .apply((sn) =>
      sn.map((id) => aws.ec2.getSubnet({ id: id }).then((s) => s.cidrBlock))
    );

  return {
    description: `All ${protocol} traffic in VPC`,
    protocol: protocol,
    fromPort: port ? port : 0,
    toPort: port ? port : 65535,
    cidrBlocks: cidrs,
  };
}
