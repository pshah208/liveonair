# Judging-period runbook (2026-10-27 to 2026-11-10)

Every Azure command names its target explicitly. Never run one without both flags.

```powershell
$S = '5d2da101-2909-479c-a12f-c07083da7c18'
$G = 'rg-matchlens-hackathon'
$App = 'liveonair'
$Url = 'https://liveonair.whiteisland-f5b236ef.eastus2.azurecontainerapps.io'
```

Secrets: `STUDIO_TOKEN` comes from a password manager into `$env:STUDIO_TOKEN` for the current shell
only. Never put it in the repo, in shell history files or in chat. The Fabric connection strings live
only in `fabric/.secrets.local.json` (gitignored).

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

`core.bicep`: what-if shows only Modify operations (tags, the cap, and server-managed read-only
properties) plus one **Create**: role assignment `a796ab82-…` (Cognitive Services Speech User for the
app identity on Foundry). If that role was ever granted by hand, the core deploy fails with
RoleAssignmentExists. Run core again only after judging, or after confirming that the role assignment
is absent.

## 2. Deploy a new app version

```powershell
$env:STUDIO_TOKEN = '<from password manager>'
$Tag = 'v0-15-0-' + (git rev-parse --short HEAD)

# Preview (no build, no change). Prints a redacted what-if.
pwsh scripts/deploy.ps1 -SubscriptionId $S -ResourceGroup $G -UseExistingInfrastructure -PreviewOnly -ImageTag $Tag

# Build in ACR (az acr build) and deploy infra/app.bicep. Refuses if:
# - the Fabric secrets are missing (unless -AllowLocalTransport);
# - STUDIO_TOKEN is missing (unless -AllowNoStudioToken);
# - App Insights is missing;
# - the tag already exists.
pwsh scripts/deploy.ps1 -SubscriptionId $S -ResourceGroup $G -UseExistingInfrastructure -ImageTag $Tag
```

Expected what-if for the container app: **Modify** only (FQDN unchanged), cpu 0.5 → 1.0,
memory 1Gi → 2Gi, a new `studio-token` secret, `DEMO_WATCHDOG_MINUTES` and `STUDIO_TOKEN` env, and tags.
The `Delete` lines for `ingress.exposedPort`, `ingress.traffic` and `runningStatus`, and the reordered
probes, are server-default noise. **Stop if** the app shows `Delete` or `Replace`, or if
`configuration.secrets` would lose `eventstream-source`, `eventstream-destination` or `appinsights-connection`.

## 3. Verify

```powershell
az containerapp show --subscription $S --resource-group $G --name $App `
  --query "{image:properties.template.containers[0].image,res:properties.template.containers[0].resources,scale:properties.template.scale,secrets:properties.configuration.secrets[].name}" -o json
pwsh scripts/smoke.ps1 -BaseUrl $Url -ExpectTransport fabric-eventstream
# Full (starts a scripted match; refuses if one is running; not during a judge's session):
pwsh scripts/smoke.ps1 -BaseUrl $Url -IncludeAI -IncludeStorylines
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

## 5. Alerts

| Alert | Severity | First steps |
|---|---|---|
| `liveonair-availability` | 1 | Open `$Url/api/health`. Check the revision health: `az containerapp revision list --subscription $S --resource-group $G --name $App -o table`. If a recent deploy is at fault, roll back. |
| `liveonair-no-replicas` | 1 | Check `az containerapp show … --query properties.runningStatus`. Check the environment and regional status. Restart with `az containerapp revision restart --subscription $S --resource-group $G --name $App --revision <latest>`. |
| `liveonair-restarts` | 2 | Check the console logs: `az containerapp logs show --subscription $S --resource-group $G --name $App --tail 200`. Look for OOM or crash loops. |
| `liveonair-memory` | 3 | Video lab or ffmpeg load; watch for restarts. |
| Budget 80% / forecast 100% | — | Check the Foundry token use and Search SKU in Cost analysis. |
| Failure Anomalies (smart detector, pre-existing) | 3 | Check App Insights failures. |

Fabric trial expiry: see decision D4 in `fabric/README.md`. The app keeps running on the local bus.
