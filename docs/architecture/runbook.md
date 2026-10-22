# Judging-period runbook (2026-10-27 to 2026-11-10)

Every Azure command names its target explicitly. Never run one without both flags.

```powershell
$S = '5d2da101-2909-479c-a12f-c07083da7c18'
$G = 'rg-matchlens-hackathon'
$App = 'liveonair'
$Url = 'https://liveonair.whiteisland-f5b236ef.eastus2.azurecontainerapps.io'
```

Studio access: **the Studio Desk is open by default** (no `STUDIO_TOKEN`; `/api/studio/auth-required`
returns `{"required":false}`). A studio token is optional hardening. If you want it, it comes from a
password manager into `$env:STUDIO_TOKEN` for the current shell only. Never put it in the repo, in
shell history files or in chat. `deploy.ps1` falls back to `$env:STUDIO_TOKEN`, so make sure it is
**unset** (`Remove-Item Env:STUDIO_TOKEN -ErrorAction SilentlyContinue`) unless you mean to turn auth on.
The Fabric connection strings live only in `fabric/.secrets.local.json` (gitignored).

## 0. Before any change

```powershell
# Record the rollback target (current image and revision).
az containerapp show --subscription $S --resource-group $G --name $App `
  --query "{image:properties.template.containers[0].image,revision:properties.latestReadyRevisionName}" -o json
# Names only: confirm the env vars and secrets that must survive the deploy.
az containerapp show --subscription $S --resource-group $G --name $App `
  --query "{env:properties.template.containers[0].env[].name,secrets:properties.configuration.secrets[].name}" -o json
```

## 1. One-time hardening (wave 2, after QA)

```powershell
# a) Log Analytics daily cap 0.1 -> 1 GB. A targeted change: infra/core.bicep already says 1 GB, but a
#    full core redeploy in the judging window is avoided (see "core.bicep" below).
az monitor log-analytics workspace update --subscription $S --resource-group $G `
  --workspace-name matchlens-logs-a6qdu7gsghg3w --quota 1

# b) Monitoring: availability test, alerts, action group, budget.
az deployment group what-if --subscription $S --resource-group $G --name matchlens-monitoring `
  --template-file infra/monitoring.bicep --parameters alertEmail=<oncall@example.com> budgetAmount=100
az deployment group create --subscription $S --resource-group $G --name matchlens-monitoring `
  --template-file infra/monitoring.bicep --parameters alertEmail=<oncall@example.com> budgetAmount=100
```

Expected monitoring what-if: **6 Create** (action group, web test, availability and memory metric alerts,
the `liveonair-restarts` scheduled query rule, the budget). Everything else is `Ignore`, with no Modify or Delete.

The restart alert is a log query on `ContainerAppSystemLogs_CL`, the table written by the environment's
`log-analytics` destination. ARM rejects the rule if the table doesn't exist. Before you rely on the alert,
open Log Analytics workspace `matchlens-logs-a6qdu7gsghg3w` > Logs in the portal and confirm that restart
rows carry the expected `Reason_s` values:

```kusto
ContainerAppSystemLogs_CL
| where TimeGenerated > ago(30d) and ContainerAppName_s == 'liveonair'
| summarize count(), max(TimeGenerated) by Reason_s
```

`core.bicep`: what-if shows only Modify operations (tags, the cap, and server-managed read-only
properties) plus one **Create**: role assignment `a796ab82-…` (Cognitive Services Speech User for the
app identity on Foundry). If that role was ever granted by hand, the core deploy fails with
RoleAssignmentExists. Run core again only after judging, or after confirming that the role assignment
is absent.

## 2. Deploy a new app version

```powershell
# Studio stays open unless a token is supplied. Clear any leftover token so it is not re-added by accident.
Remove-Item Env:STUDIO_TOKEN -ErrorAction SilentlyContinue
$Tag =  'v0-15-0-' + (git rev-parse --short HEAD)

# Preview (no build, no change). Prints a redacted what-if. Informational only; see the go/no-go below.
pwsh scripts/deploy.ps1 -SubscriptionId $S -ResourceGroup $G -UseExistingInfrastructure -PreviewOnly -ImageTag $Tag

# Build in ACR (az acr build) and deploy infra/app.bicep. Refuses if:
# - the Fabric secrets are missing (unless -AllowLocalTransport);
# - STUDIO_TOKEN is missing AND -RequireStudioToken was passed (optional hardening; off by default;
#   -AllowNoStudioToken is accepted as a deprecated no-op);
# - App Insights is missing;
# - the tag already exists.
# After the deployment it reads the secret NAMES on the container app. If a required secret is missing,
# it exits 2 (NO-GO) and prints the rollback command.
pwsh scripts/deploy.ps1 -SubscriptionId $S -ResourceGroup $G -UseExistingInfrastructure -ImageTag $Tag
```

**The go/no-go is the post-deploy secret gate in `deploy.ps1`, not the preview.** What-if shows secret
values as redacted whether they are kept or lost, so it can't prove that `eventstream-source`,
`eventstream-destination` and `appinsights-connection` survived. The gate always requires
`appinsights-connection`, and requires the Eventstream pair unless `-AllowLocalTransport` is passed. It
requires `studio-token` only when a studio token was supplied. A non-zero exit means roll back now
(section 4), then run section 3 again.

Expected what-if for the container app (open Studio, the default): **Modify** only (FQDN unchanged), with no
`studio-token` secret and no `STUDIO_TOKEN` env. If a token is supplied, expect those two to be added.
The `Delete` lines for `ingress.exposedPort`, `ingress.traffic` and `runningStatus`, and the reordered
probes, are server-default noise. **Stop before deploying if** the app shows `Delete` or `Replace`.
Secret loss isn't visible here; the post-deploy gate catches it.

## 3. Verify

```powershell
az containerapp show --subscription $S --resource-group $G --name $App `
  --query "{image:properties.template.containers[0].image,res:properties.template.containers[0].resources,scale:properties.template.scale,secrets:properties.configuration.secrets[].name}" -o json
# v0.15+ reports 'eventstream' ('local' after a fallback). The v0.14.x name 'fabric-eventstream' is also
# accepted, so this still works after a rollback. The smoke also asserts transportConfigured = true. With
# Studio open (default) it asserts /api/studio/health returns 200 without a token; with auth on, 401 without
# the token and 200 with it ($env:STUDIO_TOKEN). Add -ExpectStudioAuth only if you deployed a studio token.
pwsh scripts/smoke.ps1 -BaseUrl $Url -ExpectTransport eventstream
# Full smoke: starts a scripted match and refuses if one is running. Don't run it during a judge's session.
pwsh scripts/smoke.ps1 -BaseUrl $Url -ExpectTransport eventstream -IncludeAI -IncludeStorylines
```

## 4. Roll back

Single revision mode always routes 100% of traffic to the latest revision. Roll back by redeploying the
previous **image tag**, without rebuilding it:

```powershell
# Full rollback (template + image), same secrets:
pwsh scripts/deploy.ps1 -SubscriptionId $S -ResourceGroup $G -UseExistingInfrastructure -SkipBuild -ImageTag <previous-tag>

# Fastest image-only rollback (keeps the current config, creates a new revision):
az containerapp update --subscription $S --resource-group $G --name $App `
  --image matchlensa6qdu7gsghg3w.azurecr.io/matchlens:<previous-tag>
```

Then run section 3 again. Last known good before wave 2: `matchlens:v0-14-3-15c88b1` (revision `liveonair--0000014`).

### Studio auth on/off (config only, no rebuild)

Studio has been open since 2026-10-22 (revision `liveonair--0000016`). To turn auth back on, add the secret
first, then the env var that references it. Put the value in `$env:STUDIO_TOKEN` from a password manager;
never type it into a committed file or chat:

```powershell
az containerapp secret set --subscription $S --resource-group $G --name $App --secrets "studio-token=$env:STUDIO_TOKEN"
az containerapp update --subscription $S --resource-group $G --name $App --set-env-vars STUDIO_TOKEN=secretref:studio-token
```

To turn it off, remove the env var first, then the secret:
`az containerapp update ... --remove-env-vars STUDIO_TOKEN`, then
`az containerapp secret remove ... --secret-names studio-token`. Afterwards, run section 3 (with or without
`-ExpectStudioAuth` to match) and keep `$env:STUDIO_TOKEN` set or unset for the next `deploy.ps1` run so the
setting doesn't drift.

## 5. Alerts

| Alert | Severity | First steps |
|---|---|---|
| `liveonair-availability` | 1 | Also covers app-down. There is no replica-count alert, because metric alerts don't fire on missing data. Open `$Url/api/health`. Check the revision health: `az containerapp revision list --subscription $S --resource-group $G --name $App -o table`. If a recent deploy is at fault, roll back. |
| `liveonair-restarts` (log query) | 2 | Fires on a restart, crash or termination event in the last 15 minutes, and resolves after 15 minutes without one. Check the console logs: `az containerapp logs show --subscription $S --resource-group $G --name $App --tail 200`. Look for OOM or crash loops. If it keeps firing, restart with `az containerapp revision restart --subscription $S --resource-group $G --name $App --revision <latest>` or roll back. |
| `liveonair-memory` | 3 | Video lab or ffmpeg load; watch for restarts. |
| Budget 80% / forecast 100% | — | Check the Foundry token use and Search SKU in Cost analysis. |
| Failure Anomalies (smart detector, pre-existing) | 3 | Check App Insights failures. |

Fabric trial expiry: see decision D4 in `fabric/README.md`. The app keeps running on the local bus.
