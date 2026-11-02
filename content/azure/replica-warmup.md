+++
title = "Why a New Replica's First Request Took Seven Seconds"
date = 2026-10-01

[taxonomies]
categories = ["post"]
tags = ["azure", "container-apps", "asp.net", "performance", "cold-start"]
+++

This is part 1 of two. The change here makes the app pay a new replica's one-time startup cost before it opens its socket, instead of making the user pay it. The cost is still there. Replicas still appear and disappear all through the workday. Stopping that cycle is the actual fix, and [part 2](/azure/replica-scale-rule/) is about that.

Omni API usually answers in about 20ms. The first request to a freshly started instance took 7 seconds. The cause was not a code path. It was work the process does once. In production, the p50 of that first user request fell from 7.5 seconds to 1.3 seconds.

## 1. The symptom: only the first request is 300 times slower

The first report was "opening a chat is slow." Server latency looked fine. The p50 was 16–21ms, the same as usual. The slow requests were **the first request a new instance received.**

Fourteen days of production HTTP requests (2026-09-08 to 09-22, before the warmup, 847 instances, about 250,000 requests after undoing sampling) split cleanly by arrival order on the instance.

| Order on the instance | p50 | Share over 2 seconds |
| --- | --: | --: |
| 1st | 7,316ms | 94.2% |
| 2nd | 4,560ms | 64.9% |
| 3rd | 1,601ms | 43.7% |
| 6th–10th | 202ms | 6.8% |
| 11th–20th | 95ms | 1.6% |
| After the 100th | 23ms | 1.3% |

The average was not slow. This is the **cold-start curve** of one instance warming up. The message-list target is 2 seconds. Counting only first requests, production missed it 798 times in those 14 days.

Across every complete week still inside the 90-day retention window (07-12 to 09-27), the first-request p50 sat between 7.2 and 7.7 seconds, and 94–100% exceeded 2 seconds. It was flat. This was not a regression from one deploy. **It had always been like this.** The usual 20ms p50 hid it.

## 2. Why it happens all day: autoscaling, not deploys

"The first request on a new instance" sounds like something you suffer once per deploy. In those 14 days production started 851 instances, about 60 a day. Deploys happen once or twice a day.

| | If it were deploys | What actually happened (autoscaling) |
| --- | --- | --- |
| How often a new instance starts | Once or twice a day | 4–7 an hour during the workday, none overnight |
| How long an instance lives | Until the next deploy | p50 7.6 minutes, 59% gone within 10 minutes |
| What sets how often users hit it | The deploy cadence | The traffic cadence |

Azure Container Apps adds and removes replicas from the number of concurrent requests. Production was set to a minimum of 1, a maximum of 10, a scale-in cooldown of 300 seconds, and 0.5 vCPU with 1GiB per replica. When traffic rises, a new replica starts. Five quiet minutes later it is gone. In three days the system log recorded `scaled to N by the scaler: http-scaler` 249 times.

So this is not "an annoyance on deploy day." **Several times an hour, all through the workday, someone waits 7 seconds.**

## 3. Narrowing it down: hypotheses removed by measurement

One 5.4-second first request in the integration environment, split into spans, made no outbound call (database, cache, or identity provider) for the first 3.3 seconds. Production matched. Of a 7.2-second first request, the first outbound call started at 5.7 seconds, and every outbound call together was 0.18 seconds. **The time was inside the process.**

Plenty of things inside a process can take time. Measurement removed them one by one.

| Hypothesis | How it was checked | Result |
| --- | --- | --- |
| Entity Framework model build | A static-file request, which never touches the database, still took about 6 seconds when cold | Rejected |
| JIT compilation | An A/B with ReadyToRun: no change in the first request, image +39% | Rejected |
| Authentication (token validation) | A token signed by a local fake issuer: about 55ms on top of the rest | Rejected |
| Azure Monitor telemetry export | An on/off A/B: +5–9ms | Rejected |
| 0.5 vCPU by itself | A container with the same CPU allocation still took 2–3 seconds on the first request | Explains only part of it |
| CPU contention with background work right after start | A first request that arrived 2 minutes after start still had p50 6,985ms | Rejected |

One lesson: **read the telemetry that was already there before writing a new probe.** The three most expensive hypotheses were rejected without changing a line of code.

## 4. The useful finding: the cost is once per process

We never named a single culprit, and we could still pick a fix, because of this split. Second requests on the same instance, divided by whether they overlapped the first (one production revision, 2026-09-24 to 10-02, HTTP only):

| Request on a new instance | Count | p50 |
| --- | --: | --: |
| First request | 705 | 7,457ms |
| Second, started **after** the first finished | 258 | 760ms |
| Second, **overlapping** the first | 434 | 7,856ms |

A second request that starts after the first one finishes is usually a different endpoint, and it takes about 0.8 seconds. An overlapping request **waits for the same preparation** as the first. The cost is once per process, not once per endpoint.

Locally the shape was the same. Whatever the first request was, it paid about 700ms, including a path like `/nope-404` that matches no endpoint. The next request was 5ms even on a different endpoint. One-time work such as routing initialization and the first run of middleware lands on the first request.

That is the useful part. **Any one request through the pipeline pays most of the cost.** Have the app make that request, and the user does not.

Overlap is not a burst. During the first 10 seconds, arrivals were 0.266 per second, about twice the usual 0.135. The first request takes 7 seconds, so ordinary arrivals overlap it.

## 5. Why the health probes did not warm it

The app has `/health` and `/alive`. The first request was still cold because the platform's health probes **do not send an HTTP request.**

Container Apps runs three probes on each replica.

| Probe | When | On failure |
| --- | --- | --- |
| Startup | Right after start, until it succeeds | The replica is still starting, and receives no traffic |
| Readiness | Continuously after that | That replica receives no traffic |
| Liveness | Continuously after that | The container is restarted |

A **TCP** probe checks that a connection to the port succeeds, then disconnects. An **HTTP** probe sends a real request to a path and looks at the status code. The production spec listed no probes (`probes: null`), so the platform runs the default TCP probes. It checks that the door is unlocked, and leaves.

Two pieces of evidence:

- **System logs, 3 days:** 1,745 startup-probe connection refusals, 295 container starts. Each start is refused about six times before the port opens.
- **Request telemetry, 14 days:** an HTTP probe would have left tens of thousands of requests a day. The logs show `GET /` at 8.9 a day, `/health` at 5, and `/alive` at 3.

The design depends on the fact those numbers imply. **The moment the port opens is the moment traffic starts.** While the port is closed, traffic stays on the replicas that are already up.

The default is TCP because `/health` and `/alive` are names from the .NET Aspire template, not an industry standard. Kubernetes convention is `/healthz`, `/livez`, and `/readyz`. Spring Boot uses `/actuator/health`. The platform does not discover which paths an app has. An HTTP probe has to be told a path and a port. A platform that does not know the path can only default to TCP, which needs no path. Our deploy spec names no such path. The app exposes both routes, and nothing was configured to call them.

An HTTP probe would change the story. If the startup or readiness probe calls `/alive`, the replica receives no traffic until that probe succeeds, so **the probe's first request is the warmup.** Even if the probe times out because the first request is slow, the request still runs to completion inside the app and pays the cost. Section 6 explains why that option was not chosen. The reason is the surrounding conditions, not the effect. Switching only the liveness probe to HTTP does not warm anything. Liveness does not gate traffic, so that request arrives alongside user traffic.

### The probes we need

All three probes are needed. The platform's default TCP probes already do the job, and we do not configure them ourselves.

| Probe | What TCP does today | If it became HTTP | Decision |
| --- | --- | --- | --- |
| Startup | Holds traffic until the port opens, and restarts a container that never starts | The probe's first request would be the warmup. The in-process warmup makes that unnecessary | Keep TCP. The warmup depends on it |
| Readiness | Removes a replica whose port does not answer | Pointing it at `/health` would drop every replica at once when Blob storage blips. The app has no separate "up, but do not send traffic" state to report | Keep TCP |
| Liveness | Restarts a container whose process is alive but is not accepting connections | If `/alive` slows down under load, a healthy container gets restarted and the load gets worse | Keep TCP |

The startup probe is still required with the in-process warmup. The warmup depends on it. Warmup runs while the port is closed, and traffic stays away because the TCP startup probe says "not ready yet." The documented default is a 1-second period and a failure threshold of 240, which covers a start of about 7 seconds and a warmup cap of 30 seconds. What we do not need is an **HTTP** startup probe.

One trap: the docs do not say whether the platform fills in a startup or readiness probe that someone later removes while configuring probes by hand. Traffic could then reach a replica whose port is still closed. If probes are configured explicitly, leave a startup or readiness probe on the ingress port.

## 6. The candidates

Restated, the question is who pays the process's one-time cost, and when. The candidates fall into three groups: make the cost smaller, pay it early, or start fewer instances.

| Candidate | What it does | Decision |
| --- | --- | --- |
| ReadyToRun | Precompiles code to cut JIT | Rejected. The first request was unchanged and the image grew 39% |
| EF compiled model | Builds the data model at build time | Deferred. Only about 0.3 seconds of the request could be that |
| Open login metadata and cache connections early | Moves the first request's outbound calls into startup | Rejected. The target is 0.18 seconds |
| Send requests on a timer to keep instances warm | Keeps a living process warm | Rejected. A warm process does not go cold. The problem is a newly born instance |
| A background service sends a request after startup | The app calls itself after the port is open | Rejected. It races the first user request, and on overlap they wait together |
| Initialize routing directly | Builds the route matcher ahead of time | Rejected. It depends on framework internals and warms only routing |
| HTTP startup probe | The platform calls `/alive` at startup, and that request is the warmup | Rejected. No application code, but it changes the deploy spec, cannot be verified locally, and the probe request lands in telemetry |
| A readiness-only endpoint plus a probe | An endpoint that answers "warmup finished," checked by a probe | Rejected. The warmup code is still required, and so is the probe configuration |
| Raise the minimum replica count or the CPU | Start fewer instances, and run them faster | Out of scope for this post. It is an infrastructure setting, and it costs more |
| **One in-process request before the socket opens** | Handle one fake request inside the app just before the port opens | **Chosen. It does not remove the cost. It changes who pays it** |

Two facts picked the warmup. **Changing who pays is much easier than removing the cost.** And **while a new replica is starting, an existing replica is already serving.** A few extra seconds on the new replica do not reach the user.

That table only covers the one-time cost. Starting fewer replicas was left out at the time because it is an infrastructure setting. That call was half right. Buying more replicas is not the answer. The default scale rule was creating a cycle that was not load, and stopping that cycle is part 2. The warmup in this post is the stopgap that takes the user's 7 seconds away while the cycle continues.

### How the cost moves

Cost does not separate the options cleanly. Production runs on the Container Apps Consumption plan. The bill is vCPU-seconds and GiB-seconds while a replica is up, plus HTTP requests **that enter from outside the environment** (2 million a month free per subscription). The [billing documentation](https://learn.microsoft.com/en-us/azure/container-apps/billing) says health probe requests are not billable. What can grow is Application Insights ingestion. A probe request is an ordinary request as far as the app is concerned, so it is recorded.

| Approach | Container Apps bill | Requests stored in Application Insights |
| --- | --- | --- |
| In-process warmup (chosen) | About 2 extra seconds of CPU per start (local measurement). It is not an external request, so there is no request charge | None |
| HTTP startup probe | No increase. Probe requests are not billed | 1–3 per start, 60–180 a day in production |
| HTTP for readiness and liveness too, every 5 seconds | The request charge stays the same. The idle discount for a minimum replica might shrink (not stated in the docs) | About 34,560 a day per replica. Production's real traffic is about 15,000 requests a day |

The idle discount applies when a replica meets every listed condition, including that it is not handling HTTP requests. The docs do not say whether an HTTP probe every 5 seconds breaks that condition.

## 7. The choice: one request before the socket opens

ASP.NET Core starts in a fixed order. It builds the request pipeline, then calls `StartAsync` on the server (Kestrel), which opens the port. **The only moment with a pipeline and a still-closed port is between those two steps.** The warmup sits there.

1. Wrap the `IServer` registration. When the wrapper's `StartAsync` is called, it does not open the port yet.
2. Build a fake `GET /alive` inside the process and hand it to the pipeline. It never touches the network.
3. That request runs routing initialization and the first pass of the middleware.
4. Then call the real server's `StartAsync` and open the port. The TCP probe succeeds, and traffic starts.

The core of it:

```csharp
public async Task StartAsync<TContext>(IHttpApplication<TContext> application, CancellationToken cancellationToken)
{
    try
    {
        // Run on the thread pool so a synchronous stall (a constructor, JIT) still hits the cap.
        await Task.Run(() => WarmAsync(application, results), CancellationToken.None)
                  .WaitAsync(timeout, cancellationToken);
    }
    catch (TimeoutException exception)
    {
        logger.LogWarning(exception, "... starting the server anyway", timeout);
    }

    mark("warmed");
    await inner.StartAsync(application, cancellationToken);   // the port opens after the warmup
}

// Inside WarmAsync: build one request and put it through the pipeline.
DefaultHttpContext httpContext = new();
httpContext.Request.Method = HttpMethods.Get;
httpContext.Request.Scheme = Uri.UriSchemeHttps;
httpContext.Request.Path = "/alive";

using (SuppressInstrumentationScope.Begin())
{
    context = application.CreateContext(httpContext.Features);   // suppress telemetry on this line only
}
await application.ProcessRequestAsync(context);
```

Four rules:

- **A failure must not block startup.** If the request throws, log a warning. If 30 seconds pass, open the port anyway. Warmup is an optimization, not an availability requirement.
- **Leave no telemetry.** If the fake request is recorded, it occupies the "first request" slot on every new instance, and the metric that judges the change starts lying.
- **One request.** A second request that walked the authentication path was tried. The measured difference was inside the noise, so it came out.
- **Leave the probes on TCP.** The deploy spec does not change.

## 8. Before and after: one inserted step

```text
Before
  container start
  pipeline built
  socket opens          ← traffic starts here
  user request          ← about 7 seconds

After
  container start
  pipeline built
  in-process GET /alive ← the app spends about 2 seconds, socket still closed
  socket opens          ← traffic starts here
  user request          ← production p50 1.3 seconds
```

The only new step is the one before the port opens. The app pays the preparation cost, and the replicas already running take traffic while it does.

## 9. Five traps during the implementation

The code that sends one fake request is short. Making it behave like a real request, and leave no trace, was not. The first three traps came out of code review. The last two came out of running it.

1. **The telemetry suppression was too wide.** OpenTelemetry's `SuppressInstrumentationScope` is an AsyncLocal. Wrapping the whole request means a singleton created during that request inherits the suppressed state forever, including its timers and background work. Whether a request is recorded is decided in `CreateContext`, so the suppression covers that one line.
2. **`http` does not warm every environment.** Where an https address is configured (every local launch profile), `UseHttpsRedirection` returns 307 and the request never reaches authentication or the endpoint. Real production requests become `https` through forwarded headers, so the warmup uses `https` too.
3. **The time limit covered only the asynchronous part.** `WaitAsync` attaches after the method hits its first `await`. A synchronous stall in a constructor or in JIT means the port never opens. Wrapping the work in `Task.Run` fixed it.
4. **Metrics are not suppressed.** Against a local collector, the request trace was suppressed, and `http.server.request.duration` still received one sample of about 2 seconds per replica. A test suite that only checked traces would have called that "suppressed."
5. **The measurement setup lied.** The first local run had a process that was supposed to be dead and was not, so every request came back under 1ms. An amd64 image emulated on Apple Silicon inflates JIT. The measurement database schema was behind, so requests returned 500. In all three cases, **a strange result was a reason to suspect the measurement before the system.**

There are seven tests. To see that they guard something, the production code was broken on purpose in eight ways (mark order, suppression removed, suppression widened, the catch, the time limit, `Task.Run`, the scheme, disposing the scope). Each break failed a test.

## 10. The result: local measurement, then production

A local container with the production allocation (0.5 vCPU, 1GiB), a real SQL Server, Redis, and RabbitMQ, and a fake token issuer. The first request is a session-list query with a real token.

| | First request (3 runs) | Ready |
| --- | --- | --- |
| No warmup | 2,703 / 2,177 / 2,633ms | 9.0–9.9s |
| With warmup | 479 / 373 / 397ms | 11.7–11.8s |

The first request was about six times faster. The extra 2 seconds are spent before the port opens, so the user does not wait for them. The cost did not disappear. **The app pays it instead of the user.**

Locally we reproduced about a third of the 7.2-second production first request. The effect would be judged in production, and the bar was set before the deploy: pass if, over at least 100 new weekday instances, the first user request has a p50 under 2 seconds.

### Production: pass

The warmup ran in production from 2026-10-02 08:30Z. Over six days it ran on 397 starts, every one of them `/alive=200`, and the warmup itself took a p50 of about 2.3 seconds, close to the local 2.2 seconds.

| Production, HTTP requests only | Before | After |
| --- | --: | --: |
| Instances (weekdays) | 705 (591) | 363 (256) |
| First user request, p50 | 7,468ms | **1,285ms** |
| First user request, p90 | 10,109ms | 3,712ms |
| First requests over 2 seconds | 95.5% | 34.7% |
| Requests overlapping the first, p50 | 7,539ms | 2,490ms |
| Requests after the first finished, p50 | 304ms | 277ms |
| Requests over 2 seconds among the first 10, per instance | 3.05 | 1.55 |

- **The pass is not a fake one.** After the warmup, 369 instances recorded zero `GET /alive`. If the warmup request had leaked into telemetry, it would have occupied the first-request slot on every instance and the metric would have improved by itself. That is trap 1 from section 9, avoided.
- **Overlap shrank.** A shorter first request is a narrower window. Overlapping requests fell from 1.50 per instance to 0.90.
- **The per-endpoint remainder is unchanged.** Requests after the first finished went from 304ms to 277ms. That is the region the warmup was never going to cover.

One trap in the judgement itself: the first pass assumed there was no sampling and checked only `itemCount`, which is always 1. Azure Monitor was sampling requests, and the keep rate was on a custom dimension of the request. The requests table also contains message-consumer spans, so the first published numbers had not filtered them out. The table above is HTTP requests only. The judgement looks at an instance's first request, and that first record sat in a 100% keep-rate band for both periods (low-80%s either way), so the comparison holds. **When a judgement comes from telemetry, reconcile the total with another aggregate (the ingress metrics), and find out what else is in the table.**

### What is left

- **The remainder of the first request.** A p50 of 1.3 seconds is longer than the 0.4 seconds measured locally under the same allocation, and 34.7% of first requests are still over 2 seconds. The likely share is paths that exist only in production: App Configuration, Key Vault, Azure SignalR, TLS Redis, Azure SQL. That is an estimate from before measuring them.
- **The scale cycle.** After the warmup, container starts per 1,000 weekday ingress requests went from 3.26 to 3.72. They did not fall. The hypothesis that a slow cold request inflates concurrency and triggers scale-out on its own is not supported. Later measurement showed the default HTTP scale rule adding replicas on little traffic, unlike the formula in the docs. Moving the preparation cost does not stop replicas from being born and dying all through the workday. Stopping that cycle is [part 2](/azure/replica-scale-rule/).
- **The startup budget.** Building the request pipeline takes 2.8 seconds, and Azure App Configuration takes 1.1 seconds. Users do not wait for either. Both delay the moment a replica becomes useful.

Two things made the judgement trustworthy. The bar and the sample size were set before the deploy. And when the numbers came out well, the path that would have faked a pass was checked and found closed. The pass stops at "the first request got faster." How often a replica is created was not part of this post's bar.

The figures are from Application Insights requests and traces, and from Container Apps system logs, 2026-09-11 to 2026-10-08. Probe types and defaults are in [Health probes in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/health-probes).
