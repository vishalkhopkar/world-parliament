import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * One-time (deploy manually with `cdk deploy GithubOidcStack -c oidc=true`) stack: GitHub OIDC provider + a role
 * that GitHub Actions on vishalkhopkar/world-parliament@main can assume. Store the role ARN as the repo
 * secret AWS_DEPLOY_ROLE_ARN. If the account already has the GitHub OIDC provider, pass -c oidcProviderArn=...
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { existingProviderArn?: string }) {
    super(scope, id, props);
    const provider = props.existingProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'Provider', props.existingProviderArn)
      : new iam.OpenIdConnectProvider(this, 'Provider', {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      });
    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'hp-github-deploy',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        // This repo has GitHub's "immutable subject" OIDC option on, so the token's sub uses owner/repo ids
        // (repo:<owner>@<ownerId>/<repo>@<repoId>:...); the name-based form is kept for repos without it.
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            'repo:vishalkhopkar/world-parliament:ref:refs/heads/main',
            'repo:vishalkhopkar@12594122/world-parliament@1424053154:ref:refs/heads/main',
          ],
        },
      }),
    });
    // CDK deploys by assuming the bootstrap roles (cdk-hnb659fds-*); that is all this role needs.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-*`],
    }));
    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
