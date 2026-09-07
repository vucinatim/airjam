import { toMachineApiErrorResponse } from "@/server/auth/machine-api";
import { requireMachineSessionFromRequest } from "@/server/auth/machine-session";
import { requestReleaseGenerationExportForMachine } from "@/server/releases/machine-release";
import { platformMachineRequestReleaseGenerationExportResultSchema } from "@air-jam/sdk/platform-machine";
import { NextResponse } from "next/server";

export const POST = async (
  request: Request,
  context: {
    params: Promise<{
      releaseId: string;
      generationId: string;
    }>;
  },
) => {
  try {
    const auth = await requireMachineSessionFromRequest({ request });
    const params = await context.params;
    const result = await requestReleaseGenerationExportForMachine({
      releaseId: params.releaseId,
      generationId: params.generationId,
      userId: auth.user.id,
    });

    return NextResponse.json(
      platformMachineRequestReleaseGenerationExportResultSchema.parse(result),
    );
  } catch (error) {
    return toMachineApiErrorResponse(error);
  }
};
