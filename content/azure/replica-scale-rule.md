+++
title = "Why the API Kept Scaling Up and Down"
date = 2026-10-29

[taxonomies]
categories = ["post"]
tags = ["azure", "container-apps", "scaling", "performance"]
+++

This is part 2 of two. [Part 1](/azure/replica-warmup/) made the app pay a new replica's one-time cost instead of the user. The p50 of the first user request fell from 7.5 seconds to 1.3 seconds. The number of replicas being born did not fall. On a weekday, 60 to 90 still started, and the median replica lived 7.5 minutes. The actual fix is to stop that cycle.

Load was not what created the cycle. The app declared no scale rule, so the platform's default HTTP rule was in force, and that rule's threshold is not in the documentation. Production numbers also disagree with the formula the docs do give. The rule is now declared in the AppHost, at 50 concurrent requests and a maximum of 3 replicas. Every deploy regenerates the container app, so a value set in the portal is gone on the next deploy.

## 1. What part 1 left in place

The warmup has been running since 2026-10-02. Over the following week, 26.7% of requests on a replica younger than two minutes took more than a second. After two minutes, 3.2% did. Shortening the first request to 1.3 seconds leaves the window before a replica has settled.

The more visible path is not HTTP. A new replica joins as a RabbitMQ consumer about 4 seconds after its container starts. An inbound message it picked up then reached the screen 6 to 8 seconds later. At the same time, a message handled by a replica that was already up arrived in under a second.

Part 1's result stands. The question changed. Not who pays the one-time cost, but **why ordinary weekday traffic creates and destroys replicas dozens of times.**

## 2. There was no rule

The container app Aspire generated had `minReplicas: 1` and no scale rule. With no rule, Container Apps applies its default. The default-rule table in [Scaling in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/scale-app) says the trigger is HTTP, the minimum is 0, and the maximum is 10. Ours sets the minimum to 1, so the range is 1 to 10.

The system log still records `scaled to N by the scaler: http-scaler` while the rule is `null`. The default HTTP rule is what is running.

What the docs do say:

- The scale-up stabilization window is 0 seconds. The scale-down window is 300 seconds. Growth is immediate. Shrink waits five minutes.
- If you **define** an HTTP rule and omit `concurrentRequests`, the default is 10. Every 15 seconds the platform divides the requests from the past 15 seconds by 15. Above the threshold, it adds a replica.
- The 30-second polling interval carries a note that it does not apply to HTTP and TCP rules.

The default rule's own concurrency threshold appears nowhere in that document. The 10 in the default-rule table is the **maximum replica count**. The 10 on `concurrentRequests` is the default for a rule you defined and then left blank. On 2026-10-28, the official docs, the China mirror, and the scaling tutorial had no sentence stating the default rule's threshold.

## 3. The documented formula says it should not have scaled

The 24 hours from about 2026-10-28 01:30Z to 2026-10-29 01:50Z were counted again. `Request starting HTTP` in the console log is unsampled, so it can be used as a request count. There were 18,887 requests, 77 scale-ups, and 101 new replicas.

The p50 and p99 below include only buckets that had at least one request.

| Bucket | p50 | p99 | Max |
| --- | --: | --: | --: |
| 1 second | 2 | 18 | 37 |
| 15 seconds | 6 | 50 | 82 |
| 1 minute | 14 | 108 | 201 |

The busiest 15 seconds held 82 requests. The documented formula (requests in the past 15 seconds ÷ 15) gives 5.5. A threshold of 10 means this day should not have scaled once. It scaled 77 times.

Concurrency was rebuilt from the duration on each `Request finished HTTP` line, by counting how many of those intervals overlap. The app measured that duration, so it is shorter than what the ingress proxy sees.

| Scope | p50 | p99 | Max |
| --- | --: | --: | --: |
| All replicas | 2 | 13 | 27 |
| One replica | 1 | 9 | 27 |

The peak concurrency in the 30 seconds before a scale-up was computed for 76 events. One of the 77 had no request starting in that window, so it dropped out.

| Window | Count | p50 | p90 | Max | Above 10 |
| --- | --: | --: | --: | --: | --: |
| 30 seconds before a scale-up | 76 | 12 | 16 | 27 | 50 (66%) |
| 30-second windows with no scale-up | 1,176 | 3 | 11 | 17 | 127 (10.8%) |

Just before a scale-up the distribution sits just above 10: p25 10, p50 12, p75 14. Even so, 19 of the 76 (25%) happened below 10, and two of those had a peak of 1. A "no scale-up" window had no scale-up in that 30 seconds and none in the next 30 seconds either.

The **count** it scaled to disagrees with total concurrency even more. Under `desiredReplicas = ceil(current / target)`, five replicas require the total to pass 40.

| Scaled to | Events | Median concurrency | What a target of 10 requires |
| --- | --: | --: | --- |
| 2 | 13 | 12 | above 10 |
| 3 | 31 | 11 | above 20 |
| 4 | 16 | 13 | above 30 |
| 5 | 8 | 13 | above 40 |
| 6 | 5 | 14 | above 50 |
| 7–8 | 3 | 16 | above 60–70 |

Around 13 in flight, the app reached 5, 6, and 8 replicas. The value the scaler reads is not "total concurrent requests ÷ 10."

## 4. Documented, observed, inferred

Mixing the three makes it sound as if the threshold is known to be 10. It is not. Kept separate:

**Documented**

- With no rule, the default rule applies, and its trigger is HTTP.
- The default rule's concurrency threshold is not written down.
- An HTTP rule you define, with `concurrentRequests` omitted, defaults to 10.

**Observed**

- `http-scaler` adds replicas while the rule is empty.
- A day whose documented formula peaked at 5.5 still scaled 77 times.
- At about 13 in flight, it reached 5 replicas.

**Inferred**

- "The default rule also uses 10" has only indirect support: the trigger is HTTP, the omitted-value default is 10, and the median just before a scale-up is 12. There is no sentence that says it.
- The value the scaler reads is not in Azure Monitor. A per-replica value, or active connections, is the guess closest to [azure-container-apps#536](https://github.com/microsoft/azure-container-apps/issues/536). It was not confirmed.
- Durations rebuilt from application logs can undercount the proxy's concurrency. The direction holds. Stretching them does not produce 40.

The exact identity of the threshold is not required for the decision. **An undeclared rule is creating replicas on ordinary traffic, and its input is not the request count we measure.**

## 5. A new replica is not only a slow HTTP server

Around 20:56 KST on 2026-10-28, a report that messages were arriving late was traced. A replica was already up. With a minimum of 1, this was not a scale-from-zero cold start.

| Time (UTC) | Event |
| --- | --- |
| 11:31:21 | Scaled down to 1 |
| 11:56:36 | `http-scaler` scaled to 2 and assigned a new replica |
| 11:56:48 | That replica's container started. Startup-probe failures continued for about 10 seconds |
| 11:56:51 | Scaled to 3 and assigned another replica |
| 11:56:52 | The first new replica registered its MassTransit endpoints and started consuming, about 4 seconds after the container start |
| 11:57:09 | The second new replica's container started |

Ingress just before that was 0, 8, 0, and 22 requests a minute from 11:54 to 11:57. The rest of the system was idle the same day. SQL CPU peaked at 1–5% (once 18%) and workers stayed under 3%. RabbitMQ used about 0.02 cores and 210MB. SignalR server load was about 12%, with at most 53 connections. Redis memory was 2%. The replica working set did pin at 1.01–1.13GB against the 1Gi limit, every day. Whether that is related to this delay was not established.

Four inbound messages. The span is from receiving the webhook to broadcasting the inbound message. Console-log timestamps are bucketed to about a second, so the end-to-end figures have ±1–2 seconds of error. The time the messenger sent the webhook is not in the logs.

| Webhook (UTC) | Replica that handled the webhook | Replica that consumed the message | End to end |
| --- | --- | --- | --- |
| 11:56:39 | The existing replica, 60ms | The existing replica | under about 1 second |
| 11:57:25 | A replica 16 seconds old, 1,057ms | The existing replica | about 1–2 seconds |
| 11:57:49 | The existing replica, 55ms | A replica 1 minute old | **about 6–7 seconds** |
| 12:00:53 | Another new replica, 2,082ms | A replica a few minutes old | **about 8 seconds** |

Split the 6–7 second case on the consuming replica: about a second to process the envelope, about four more to create the message row, and another one to two seconds to broadcast. On the existing replica the same path finished in under a second.

Over the surrounding 24 hours (10-27 12:20Z to 10-28 12:20Z) there were 87 scale-ups, 97 scale-downs, and 105 new replicas. Part 1's baseline week had 52–78 scale-ups and 60–90 container starts. Scale-ups were zero from 01:00 to 07:00 KST and 3–8 an hour the rest of the day. New tenants had not arrived yet.

The cost of the cycle is not only HTTP latency. **The moment a new replica joins as a competing consumer, the delay shows up in the inbox.**

## 6. The candidates

| Candidate | Decision |
| --- | --- |
| An explicit HTTP rule, with `concurrentRequests` and the maximum replica count as deploy parameters | **Chosen.** Defining any rule removes the default rule. The values are environment variables, so they change without a code change |
| Keep the default rule and look again when tenants arrive | This was the decision on 2026-10-09. Reversed on 2026-10-29, after 10-28 showed the cycle as message latency |
| Raise the minimum to 2 and change nothing else | Rejected. The default rule stays. Scale-ups above two replicas happened 241 times in five days |
| Minimum 2, plus a CPU rule | Rejected. In their first minute, replicas crossed 80% CPU in 2.6% of minutes while serving 0–25 requests. A deploy that starts two replicas together can push the average over the threshold. Whether the platform ignores startup CPU is not documented |
| Minimum 2, maximum 2 | Rejected. The cycle stops, and the app cannot grow when tenants arrive |
| Set the rule in the portal or with the CLI | Rejected. The next deploy regenerates the container app and overwrites the scale block |

Raising the minimum is the option that comes to mind first, because the flip between one and two replicas goes away. It also leaves the undocumented threshold in place, and it leaves the cycle above two replicas in place. Observed scale-ups did not stop at two. They reached eight.

## 7. The choice: write the rule into the deploy code

The deploy code writes the container app's scale block. The maximum replica count and the concurrency target are parameters.

```csharp
app.Template.Scale.MaxReplicas = maxReplicas;
app.Template.Scale.Rules =
[
    new ContainerAppScaleRule
    {
        Name = "http-scaler",
        Http = new ContainerAppHttpScaleRule
        {
            Metadata = { ["concurrentRequests"] = concurrentRequests },
        },
    },
];
```

The block `aspire publish` generates looks like this.

```bicep
scale: {
  minReplicas: 1
  maxReplicas: int(chatapi_MaxReplicas)
  rules: [
    {
      name: 'http-scaler'
      http: {
        metadata: {
          concurrentRequests: chatapi_ConcurrentRequests
        }
      }
    }
  ]
}
```

The minimum stays at the 1 Aspire generates. Defining one rule removes the platform default.

Integration, Staging, and Production use the same values: `concurrentRequests` **50**, `maxReplicas` **3**.

- **50** is above this day's in-flight peak of 27. A second replica should appear only under load clearly heavier than what we measured.
- **3** is a lid. If the rule still misfires, the cycle cannot run far. At 50 per replica, three replicas hold about twice the measured peak.

Neither number is the result of a capacity test. They are starting points to be moved by measurement. The same HTTP scaler has been reported to scale out early with an explicit threshold of 2000 ([Microsoft Q&A 2288688](https://learn.microsoft.com/en-us/answers/questions/2288688/our-container-app-http-scaler-kicks-of-scaling-way)). Whether 50 stays quiet is something only production measurement can say.

The values are passed in as deploy parameters for each environment. Changing the number does not require another code change. A local deploy needs the same two values in that environment's settings file.

## 8. What this decision does not do

- **It does not replace the warmup from part 1.** A deploy still births a new replica, and real load past the threshold births a second and a third. The first pass through the pipeline on a replica that does start is still paid by the app, before the socket opens. The warmup is a stopgap because it cannot prevent the births that repeat all day, not because it failed.
- **It does not change when a new replica starts consuming.** MassTransit endpoints still register about 4 seconds after the container starts. This decision makes that happen less often.
- **Capacity stops at three replicas of 0.5 vCPU.** Under the default rule, production reached eight. If new tenants outgrow three, the parameters go up and the app is deployed again.
- **This rule can misfire too.** It is the same scaler. Watch for minutes stuck at three replicas.
- **Nothing tests the generated scale block.** Nothing in code checks that the environment variables are actually 50 and 3.

Older notes sized cost against ten replicas. Those notes were left as they are. Read them now with three as the upper bound.

## 9. What counts as a pass

The bar goes in writing before the deploy. The comparison window is the weekdays of 2026-10-01 to 10-08. The rule went in on 2026-10-29. At the time of writing, the weekday remeasurement is not in yet. No improved number is claimed ahead of it.

| Measure | Before (10-01 to 10-08) | Target |
| --- | --- | --- |
| Container starts a day | 60–90 | Lower |
| Minutes with two or more replicas | 609–919 | Lower |
| Response p50 | 24–42ms | Not worse |
| Response p90 | 169–912ms | Not worse |

The baseline is from before new tenants. Once they arrive, compare per request. Also watch minutes pinned at three replicas, and CPU per replica.

In part 1, setting the bar and the sample size before the deploy is what made the judgement believable. The same standard applies here. A pass is not "the rule is in the code." A pass is fewer containers born on a weekday, with the response times no worse.
