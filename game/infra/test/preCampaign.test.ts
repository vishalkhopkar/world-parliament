// The pre-campaign in the infrastructure. A game with a pre-campaign starts its state machine with preCampaignEndIso: the execution waits
// for that time and runs OpenCampaign before the phases. A 2-player game has no such input and skips both. Field and withdraw are named
// WebSocket routes like the other game actions, and OpenCampaign is a Lambda of its own that the state machine may invoke.
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { ApiStack } from '../lib/api-stack';
import type { Config } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { Lifecycle } from '../lib/lifecycle';
import { WebStack } from '../lib/web-stack';

type State = { Type: string; Next?: string; Default?: string; Choices?: { Variable?: string; IsPresent?: boolean; Next: string }[]; SecondsPath?: string; TimestampPath?: string; Catch?: { Next: string }[]; Retry?: unknown[]; ResultPath?: unknown };

/** The state machine's definition as an object; CloudFormation references inside its string are replaced by a placeholder. */
function definitionOf(t: Template): { StartAt: string; States: Record<string, State> } {
  const machine = Object.values(t.findResources('AWS::StepFunctions::StateMachine'))[0] as { Properties: { DefinitionString: unknown } };
  const raw = machine.Properties.DefinitionString;
  if (typeof raw === 'string') return JSON.parse(raw);
  const parts = (raw as { 'Fn::Join': [string, unknown[]] })['Fn::Join'][1];
  return JSON.parse(parts.map((x) => (typeof x === 'string' ? x : 'REF')).join(''));
}

describe('the lifecycle state machine', () => {
  const stack = new Stack(new App(), 'L', { env: { region: 'ap-south-1', account: '111111111111' } });
  const fn = (name: string) => lambda.Function.fromFunctionArn(stack, name, `arn:aws:lambda:ap-south-1:111111111111:function:${name}`);
  new Lifecycle(stack, 'Lifecycle', {
    prefix: 'x-', isProd: false, openCampaign: fn('open-campaign'), phaseClose: fn('phase-close'), countReveal: fn('count-reveal'), finalise: fn('finalise'),
    graceCheck: fn('grace-check'), stateMachineName: 'x-game-lifecycle', schedulerRoleName: 'x-scheduler', scheduleGroupName: 'x-grace',
  });
  const def = definitionOf(Template.fromStack(stack));

  it('starts with a choice: an execution with preCampaignEndIso goes to the wait, any other straight to the phases', () => {
    const start = def.States[def.StartAt];
    expect(start.Type).toBe('Choice');
    expect(start.Choices).toEqual([{ Variable: '$.preCampaignEndIso', IsPresent: true, Next: 'WaitPreCampaignEnd' }]);
    expect(start.Default).toBe('Phases');
  });

  it('waits until preCampaignEndIso, runs OpenCampaign, then continues with the phases', () => {
    expect(def.States.WaitPreCampaignEnd).toMatchObject({ Type: 'Wait', TimestampPath: '$.preCampaignEndIso', Next: 'OpenCampaign' });
    expect(def.States.OpenCampaign).toMatchObject({ Type: 'Task', Next: 'Phases' });
  });

  it('OpenCampaign retries like the other steps, keeps the execution input and ends the game through FinaliseOnError on failure', () => {
    const open = def.States.OpenCampaign;
    expect(open.Retry?.length).toBeGreaterThan(0);
    expect(open.ResultPath).toBeNull();
    expect(open.Catch?.[0].Next).toBe('FinaliseOnError');
  });

  it('the rest of the lifecycle is unchanged: phases, counting loop, finalise', () => {
    expect(def.States.Phases.Next).toBe('CountReveal');
    expect(def.States.CountReveal.Next).toBe('CountingDone?');
  });
});

describe('the API stack', () => {
  const cfg: Config = { stage: 'dev', prefix: 'hp-dev-', isProd: false, region: 'ap-south-1', account: '111111111111', budgetUsd: 20 };
  const app = new App();
  const env = { region: cfg.region, account: cfg.account };
  const data = new DataStack(app, 'D', { env, cfg });
  const web = new WebStack(app, 'W', { env, cfg });
  const t = Template.fromStack(new ApiStack(app, 'A', { env, cfg, table: data.table, reportBucket: data.reportBucket, webOrigin: web.origin }));

  it('has named WebSocket routes for field and withdraw', () => {
    const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map((r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey);
    expect(routes).toEqual(expect.arrayContaining(['field', 'withdraw', 'campaign', '$default']));
  });

  it('has the open-campaign Lambda with an error alarm like every other function', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'hp-dev-open-campaign' });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'hp-dev-open-campaign-errors' });
  });

  it('lets the state machine invoke the open-campaign Lambda', () => {
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('Fnopencampaign');
  });
});
