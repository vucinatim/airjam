import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomBytes, randomUUID } from "node:crypto";

import { createCloudflareR2TemporaryCredentials } from "./cloudflare-r2-temporary-credentials.mjs";
import {
  assertGoldenPathStagingEnvironmentIsolation,
  collectGoldenPathServiceVariablePairs,
  resolveGoldenPathRailwayStagingTarget,
  resolveGoldenPathStagingEnvironmentPair,
} from "./golden-path-staging-target.mjs";
import { createRailwayApiClient } from "./railway-api.mjs";

const requiredText = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
};

const randomSecret = () => randomBytes(32).toString("base64url");

const serviceByName = (environment, name) => {
  const service = environment.serviceInstances.find(
    (candidate) => candidate.serviceName === name,
  );
  if (!service) {
    throw new Error(
      `Railway environment ${environment.name} is missing ${name}.`,
    );
  }
  return service;
};

const serviceOrigin = (service) => {
  const domain = service.domains?.serviceDomains?.[0]?.domain;
  if (!domain) {
    throw new Error(
      `Railway service ${service.serviceName} has no environment-scoped public domain.`,
    );
  }
  return new URL(`https://${domain}`).origin;
};

const assertDormantStagingShell = (environment) => {
  const deployedServices = environment.serviceInstances.filter(
    (service) => service.latestDeployment,
  );
  if (deployedServices.length > 0) {
    throw new Error(
      `Golden-path staging must be provisioned before its first deployment; found ${deployedServices.map((service) => service.serviceName).join(", ")}.`,
    );
  }
};

const createR2Client = ({ endpoint, credentials }) =>
  new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials,
  });

const probeTemporaryR2Isolation = async ({
  endpoint,
  stagingBucket,
  productionBucket,
  parentCredentials,
  temporaryCredentials,
}) => {
  const key = `_airjam/golden-path-probe/${randomUUID()}`;
  const scopedClient = createR2Client({
    endpoint,
    credentials: temporaryCredentials,
  });
  const parentClient = createR2Client({
    endpoint,
    credentials: parentCredentials,
  });
  let stagingWriteSucceeded = false;
  let productionWriteSucceeded = false;
  let productionReadDenied = false;
  let productionWriteDenied = false;
  let probeObjectRemoved = false;
  try {
    await scopedClient.send(
      new PutObjectCommand({
        Bucket: stagingBucket,
        Key: key,
        Body: "air-jam-golden-path-staging-probe",
      }),
    );
    stagingWriteSucceeded = true;

    try {
      await scopedClient.send(
        new HeadObjectCommand({ Bucket: productionBucket, Key: key }),
      );
    } catch (error) {
      productionReadDenied =
        error?.name === "AccessDenied" ||
        error?.$metadata?.httpStatusCode === 403;
    }
    if (!productionReadDenied) {
      throw new Error(
        "The proposed staging R2 credential was not denied read access to production storage.",
      );
    }

    try {
      await scopedClient.send(
        new PutObjectCommand({
          Bucket: productionBucket,
          Key: key,
          Body: "air-jam-golden-path-production-denial-probe",
        }),
      );
      productionWriteSucceeded = true;
    } catch (error) {
      productionWriteDenied =
        error?.name === "AccessDenied" ||
        error?.$metadata?.httpStatusCode === 403;
    }
    if (!productionWriteDenied) {
      throw new Error(
        "The proposed staging R2 credential was not denied write access to production storage.",
      );
    }
  } finally {
    if (stagingWriteSucceeded) {
      await parentClient.send(
        new DeleteObjectCommand({ Bucket: stagingBucket, Key: key }),
      );
      probeObjectRemoved = true;
    }
    if (productionWriteSucceeded) {
      await parentClient.send(
        new DeleteObjectCommand({ Bucket: productionBucket, Key: key }),
      );
    }
  }

  return {
    stagingWrite: stagingWriteSucceeded,
    productionReadDenied,
    productionWriteDenied,
    probeObjectRemoved,
  };
};

export const provisionGoldenPathStaging = async ({
  projectId,
  environmentId,
  releaseOrigin,
  r2Bucket,
  ttlSeconds = 24 * 60 * 60,
  client = createRailwayApiClient({ requestTimeoutMs: 30_000 }),
  now = Date.now(),
  probeR2Isolation = probeTemporaryR2Isolation,
}) => {
  const {
    environment,
    primaryEnvironment,
    primaryEnvironmentId,
    servicePairs,
  } = await resolveGoldenPathStagingEnvironmentPair({
    projectId,
    environmentId,
    client,
  });
  assertDormantStagingShell(environment);

  const platform = serviceByName(environment, "air-jam-platform");
  const worker = serviceByName(environment, "air-jam-platform-worker");
  const browser = serviceByName(environment, "air-jam-release-browser-worker");
  const server = serviceByName(environment, "air-jam-server");
  const platformOrigin = serviceOrigin(platform);
  const workerOrigin = serviceOrigin(worker);
  const browserOrigin = serviceOrigin(browser);
  const serverOrigin = serviceOrigin(server);
  const normalizedReleaseOrigin = new URL(
    requiredText(releaseOrigin, "Staging release origin"),
  ).origin;
  const releaseHostname = new URL(normalizedReleaseOrigin).hostname;
  if (
    !platform.domains?.customDomains?.some(
      (domain) => domain.domain === releaseHostname,
    )
  ) {
    throw new Error(
      `Staging release origin ${releaseHostname} is not attached to the staging platform service.`,
    );
  }
  if (normalizedReleaseOrigin === platformOrigin) {
    throw new Error(
      "Staging release origin must be distinct from its authenticated platform origin.",
    );
  }

  const primaryPlatform = serviceByName(primaryEnvironment, "air-jam-platform");
  const primaryVariables = await client.getVariables({
    projectId,
    environmentId: primaryEnvironment.id,
    serviceId: primaryPlatform.serviceId,
  });
  const accountId = requiredText(
    primaryVariables.AIRJAM_RELEASES_R2_ACCOUNT_ID,
    "Production R2 account id",
  );
  const parentAccessKeyId = requiredText(
    primaryVariables.AIRJAM_RELEASES_R2_ACCESS_KEY_ID,
    "Production R2 access key id",
  );
  const parentSecretAccessKey = requiredText(
    primaryVariables.AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY,
    "Production R2 secret access key",
  );
  const productionBucket = requiredText(
    primaryVariables.AIRJAM_RELEASES_R2_BUCKET,
    "Production R2 bucket",
  );
  const endpoint =
    primaryVariables.AIRJAM_RELEASES_R2_ENDPOINT?.trim() ||
    `https://${accountId}.r2.cloudflarestorage.com`;
  const temporaryCredential = createCloudflareR2TemporaryCredentials({
    endpoint,
    accountId,
    parentAccessKeyId,
    parentSecretAccessKey,
    bucket: r2Bucket,
    ttlSeconds,
    now,
  });
  const r2Probe = await probeR2Isolation({
    endpoint,
    stagingBucket: temporaryCredential.bucket,
    productionBucket,
    parentCredentials: {
      accessKeyId: parentAccessKeyId,
      secretAccessKey: parentSecretAccessKey,
    },
    temporaryCredentials: {
      accessKeyId: temporaryCredential.accessKeyId,
      secretAccessKey: temporaryCredential.secretAccessKey,
      sessionToken: temporaryCredential.sessionToken,
    },
  });

  const appId = `air-jam-staging-${randomUUID()}`;
  const masterKey = randomSecret();
  const hostGrantSecret = randomSecret();
  const browserAccessToken = randomSecret();
  const internalAccessToken = randomSecret();
  const workerControlToken = randomSecret();
  const authSecret = randomSecret();
  const browserWebSocketUrl = `${browserOrigin.replace(/^https:/u, "wss:")}/ws`;
  const sharedReleaseVariables = {
    AIRJAM_RELEASES_R2_BUCKET: temporaryCredential.bucket,
    AIRJAM_RELEASES_R2_ACCOUNT_ID: accountId,
    AIRJAM_RELEASES_R2_ACCESS_KEY_ID: temporaryCredential.accessKeyId,
    AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY: temporaryCredential.secretAccessKey,
    AIRJAM_RELEASES_R2_SESSION_TOKEN: temporaryCredential.sessionToken,
    AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN: internalAccessToken,
    AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN: browserAccessToken,
    AIRJAM_RELEASES_BROWSER_WS_ENDPOINT: browserWebSocketUrl,
    AIRJAM_RELEASES_IMAGE_MODERATION_MODE: "disabled",
    AIRJAM_RELEASES_PUBLIC_ORIGIN: normalizedReleaseOrigin,
  };

  const variableUpdates = [
    {
      serviceId: platform.serviceId,
      variables: {
        ...sharedReleaseVariables,
        AIR_JAM_HOST_GRANT_SECRET: hostGrantSecret,
        AIR_JAM_MASTER_KEY: masterKey,
        AIR_JAM_SYSTEM_APP_ID: appId,
        BETTER_AUTH_SECRET: authSecret,
        BETTER_AUTH_URL: platformOrigin,
        GITHUB_CLIENT_ID: "",
        GITHUB_CLIENT_SECRET: "",
        NEXT_PUBLIC_AIR_JAM_APP_ID: appId,
        NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST: platformOrigin,
        NEXT_PUBLIC_AIR_JAM_SERVER_URL: serverOrigin,
        NEXT_PUBLIC_APP_URL: platformOrigin,
        NEXT_PUBLIC_AUTH_GITHUB_ENABLED: "false",
        OPENAI_API_KEY: "",
      },
    },
    {
      serviceId: worker.serviceId,
      variables: {
        ...sharedReleaseVariables,
        AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MODE: "disabled",
        AIRJAM_PLATFORM_WORKER_CONTROL_TOKEN: workerControlToken,
        AIRJAM_SYNTHETIC_APP_ID: appId,
        AIRJAM_SYNTHETIC_BROWSER_WORKER_ORIGIN: browserOrigin,
        AIRJAM_SYNTHETIC_HOSTED_RELEASE_URL: "",
        AIRJAM_SYNTHETIC_WORKER_ORIGIN: workerOrigin,
        AIR_JAM_SYSTEM_APP_ID: appId,
        NEXT_PUBLIC_AIR_JAM_APP_ID: appId,
        NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST: platformOrigin,
        NEXT_PUBLIC_AIR_JAM_SERVER_URL: serverOrigin,
        NEXT_PUBLIC_APP_URL: platformOrigin,
        RAILWAY_PROJECT_TOKEN: "",
      },
    },
    {
      serviceId: server.serviceId,
      variables: {
        AIR_JAM_ALLOWED_ORIGINS: platformOrigin,
        AIR_JAM_AUTH_MODE: "required",
        AIR_JAM_HOST_GRANT_SECRET: hostGrantSecret,
        AIR_JAM_MASTER_KEY: masterKey,
      },
    },
    {
      serviceId: browser.serviceId,
      variables: {
        AIRJAM_BROWSER_WORKER_ACCESS_TOKEN: browserAccessToken,
      },
    },
  ];
  for (const update of variableUpdates) {
    await client.upsertVariableCollection({
      projectId,
      environmentId,
      serviceId: update.serviceId,
      skipDeploys: true,
      variables: update.variables,
    });
  }

  const refreshedEnvironment = await client.getEnvironment(environmentId);
  const serviceVariablePairs = await collectGoldenPathServiceVariablePairs({
    client,
    projectId,
    environmentId,
    primaryEnvironmentId,
    servicePairs,
  });
  const isolation = assertGoldenPathStagingEnvironmentIsolation({
    environment: refreshedEnvironment,
    primaryEnvironment,
    serviceVariablePairs,
  });

  return {
    ok: true,
    projectId,
    environmentId,
    environmentName: refreshedEnvironment.name,
    platformOrigin,
    releaseOrigin: normalizedReleaseOrigin,
    r2: {
      bucket: temporaryCredential.bucket,
      scope: temporaryCredential.scope,
      issuedAt: temporaryCredential.issuedAt,
      expiresAt: temporaryCredential.expiresAt,
      ttlSeconds: temporaryCredential.ttlSeconds,
      probe: r2Probe,
    },
    isolation,
    deploymentStarted: false,
  };
};

const assertDeploymentSucceeded = (result, serviceName) => {
  if (!result?.ok || !result.deployment?.id) {
    throw new Error(
      `Railway staging deployment failed for ${serviceName} (${result?.deployment?.status ?? "unknown"}).`,
    );
  }
  return {
    serviceName,
    deploymentId: result.deployment.id,
    status: result.deployment.status,
  };
};

export const deployGoldenPathStaging = async ({
  projectId,
  environmentId,
  commitSha,
  client = createRailwayApiClient({ requestTimeoutMs: 30_000 }),
  fetchImpl = fetch,
  onProgress = () => {},
}) => {
  const normalizedCommitSha = requiredText(commitSha, "Git commit SHA");
  if (!/^[0-9a-f]{40}$/u.test(normalizedCommitSha)) {
    throw new Error("Golden-path staging requires one full lowercase Git SHA.");
  }
  const {
    environment,
    primaryEnvironment,
    primaryEnvironmentId,
    servicePairs,
    stagingPostgres,
  } = await resolveGoldenPathStagingEnvironmentPair({
    projectId,
    environmentId,
    client,
  });
  const serviceVariablePairs = await collectGoldenPathServiceVariablePairs({
    client,
    projectId,
    environmentId,
    primaryEnvironmentId,
    servicePairs,
  });
  assertGoldenPathStagingEnvironmentIsolation({
    environment,
    primaryEnvironment,
    serviceVariablePairs,
  });

  const platform = serviceByName(environment, "air-jam-platform");
  const server = serviceByName(environment, "air-jam-server");
  const browser = serviceByName(environment, "air-jam-release-browser-worker");
  const worker = serviceByName(environment, "air-jam-platform-worker");

  const deployAndWait = async (service, sha = normalizedCommitSha) => {
    onProgress(`deploy:${service.serviceName}:trigger`);
    const deploymentId = await client.triggerServiceDeployment({
      environmentId,
      serviceId: service.serviceId,
      commitSha: sha,
    });
    const result = await client.waitForDeployment({ deploymentId });
    const evidence = assertDeploymentSucceeded(result, service.serviceName);
    onProgress(`deploy:${service.serviceName}:success`);
    return evidence;
  };

  const deployments = [];
  deployments.push(await deployAndWait(stagingPostgres, null));
  deployments.push(await deployAndWait(platform));
  deployments.push(
    ...(await Promise.all([deployAndWait(server), deployAndWait(browser)])),
  );
  deployments.push(await deployAndWait(worker));

  const target = await resolveGoldenPathRailwayStagingTarget({
    projectId,
    environmentId,
    client,
    fetchImpl,
  });
  return {
    ok: true,
    projectId,
    environmentId,
    commitSha: normalizedCommitSha,
    deployments,
    target,
  };
};

export const emptyGoldenPathStagingBucket = async ({
  projectId,
  environmentId,
  client = createRailwayApiClient({ requestTimeoutMs: 30_000 }),
}) => {
  const {
    environment,
    primaryEnvironment,
    primaryEnvironmentId,
    servicePairs,
  } = await resolveGoldenPathStagingEnvironmentPair({
    projectId,
    environmentId,
    client,
  });
  const serviceVariablePairs = await collectGoldenPathServiceVariablePairs({
    client,
    projectId,
    environmentId,
    primaryEnvironmentId,
    servicePairs,
  });
  assertGoldenPathStagingEnvironmentIsolation({
    environment,
    primaryEnvironment,
    serviceVariablePairs,
  });
  const platform = serviceByName(environment, "air-jam-platform");
  const variables = await client.getVariables({
    projectId,
    environmentId,
    serviceId: platform.serviceId,
  });
  const endpoint =
    variables.AIRJAM_RELEASES_R2_ENDPOINT?.trim() ||
    `https://${requiredText(variables.AIRJAM_RELEASES_R2_ACCOUNT_ID, "Staging R2 account id")}.r2.cloudflarestorage.com`;
  const bucket = requiredText(
    variables.AIRJAM_RELEASES_R2_BUCKET,
    "Staging R2 bucket",
  );
  const clientCredentials = {
    accessKeyId: requiredText(
      variables.AIRJAM_RELEASES_R2_ACCESS_KEY_ID,
      "Staging R2 access key id",
    ),
    secretAccessKey: requiredText(
      variables.AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY,
      "Staging R2 secret access key",
    ),
    sessionToken: requiredText(
      variables.AIRJAM_RELEASES_R2_SESSION_TOKEN,
      "Staging R2 session token",
    ),
  };
  const r2 = createR2Client({ endpoint, credentials: clientCredentials });
  let deletedObjects = 0;
  let continuationToken;
  do {
    const page = await r2.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = (page.Contents ?? [])
      .map((object) => object.Key)
      .filter(Boolean)
      .map((Key) => ({ Key }));
    if (objects.length > 0) {
      const result = await r2.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        }),
      );
      if (result.Errors?.length) {
        throw new Error(
          `R2 refused to delete ${result.Errors.length} staging objects.`,
        );
      }
      deletedObjects += objects.length;
    }
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return { ok: true, bucket, deletedObjects };
};
