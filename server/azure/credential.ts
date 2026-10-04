import { AzureCliCredential, ManagedIdentityCredential, type TokenCredential } from "@azure/identity";

export function getAzureCredential(env: NodeJS.ProcessEnv = process.env): TokenCredential {
  if (env.NODE_ENV === "production") {
    return new ManagedIdentityCredential({
      clientId: env.AZURE_CLIENT_ID,
    });
  }

  return new AzureCliCredential({
    subscription: env.AZURE_SUBSCRIPTION_ID,
    tenantId: env.AZURE_SUBSCRIPTION_ID ? undefined : env.AZURE_TENANT_ID,
  });
}
