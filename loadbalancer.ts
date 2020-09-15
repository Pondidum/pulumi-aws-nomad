import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ComponentResource, ComponentResourceOptions } from "@pulumi/pulumi";
import { tcpFromGroup } from "./security";

export interface LoadBalancerConfig {
  vpcId: pulumi.Input<string>;
  subnets: pulumi.Input<string>[];
  listeners: ListenerConfig[];
}

export interface ListenerConfig {
  port: number;
  protocol: string;
  certificateArn?: string;
}

export class LoadBalancer extends ComponentResource {
  private readonly name: string;
  private readonly conf: LoadBalancerConfig;

  loadBalancerSG: aws.ec2.SecurityGroup;
  targetSG: aws.ec2.SecurityGroup;
  loadBalancer: aws.lb.LoadBalancer;
  targets: aws.lb.TargetGroup[];

  constructor(
    name: string,
    args: LoadBalancerConfig,
    opts?: ComponentResourceOptions
  ) {
    super("pondidum:load-balancer", name, {}, opts);

    this.name = name;
    this.conf = args;

    this.loadBalancerSG = this.createSecurityGroup();
    this.targetSG = this.createTargetSecurityGroup(this.loadBalancerSG);

    this.loadBalancer = new aws.lb.LoadBalancer(
      `${this.name}-lb`,
      {
        name: this.name,
        subnets: this.conf.subnets,
        securityGroups: [this.loadBalancerSG.id],
      },
      { parent: this }
    );

    this.targets = this.conf.listeners.map((c) =>
      this.createTarget(this.loadBalancer, c)
    );
  }

  private createTargetSecurityGroup(source: aws.ec2.SecurityGroup) {
    const ingress = this.conf.listeners.map((c) =>
      tcpFromGroup(c.port, source.id, `${c.port}-${c.protocol}`)
    );

    return new aws.ec2.SecurityGroup(
      `${this.name}-lb-sg-target`,
      {
        namePrefix: this.name,
        description: "Traffic from LoadBalancer",
        vpcId: this.conf.vpcId,

        ingress: ingress,
      },
      { parent: this }
    );
  }

  private createSecurityGroup() {
    const ingress = this.conf.listeners.map((c) => ({
      protocol: "tcp",
      toPort: c.port,
      fromPort: c.port,
      cidrBlocks: ["0.0.0.0/0"],
    }));

    return new aws.ec2.SecurityGroup(
      `${this.name}-lb-sg`,
      {
        description: "Traffic to LoadBalancer",
        vpcId: this.conf.vpcId,

        ingress: ingress,

        egress: [
          { fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] },
        ],
      },
      { parent: this }
    );
  }

  private createTarget(lb: aws.lb.LoadBalancer, conf: ListenerConfig) {
    const targetGroup = new aws.lb.TargetGroup(
      `${this.name}-target-group-${conf.port}`,
      {
        namePrefix: this.name.substr(0, this.name.indexOf("-")),
        vpcId: this.conf.vpcId,
        targetType: "instance",
        port: conf.port,
        protocol: conf.protocol,
      },
      { parent: this }
    );

    const listener = new aws.lb.Listener(
      `${this.name}-lb-listener-${conf.port}`,
      {
        loadBalancerArn: lb.arn,
        port: conf.port,
        protocol: conf.protocol,
        certificateArn: conf.certificateArn,
        defaultActions: [
          {
            type: "forward",
            targetGroupArn: targetGroup.arn,
          },
        ],
      },
      { parent: targetGroup }
    );

    return targetGroup;
  }

  targetSecurityGroup(): pulumi.Output<string> {
    return this.targetSG.id;
  }

  targetGroups(): pulumi.Output<string>[] {
    return this.targets.map((t) => t.id);
  }

  dnsName(): pulumi.Output<string> {
    return this.loadBalancer.dnsName;
  }
}
