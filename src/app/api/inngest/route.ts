import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { inngestFunctions } from "@/lib/inngest/functions";

const handler = serve({ client: inngest, functions: inngestFunctions });

export const GET = handler.GET;
export const POST = handler.POST;
export const PUT = handler.PUT;
