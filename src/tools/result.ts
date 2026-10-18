import { CtError, errorText } from "../ct/client.js";
import { PlanError } from "../plans.js";

/** The safe text of an error plus a CtError's status and field errors or a PlanError's details. */
function failure(error: unknown) {
  const message = errorText(error);
  if (error instanceof CtError) {
    const { status, errors, args } = error;
    return { message, details: { status, errors, args } };
  }
  return { message, details: error instanceof PlanError ? error.details : {} };
}

/** Every tool answers JSON text; a failure is an `isError` result (with a PlanError's details or a CtError's status and field errors), never a thrown error. */
export async function toolResult(run: () => Promise<unknown>) {
  try {
    const value = await run();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
    };
  } catch (error) {
    const { message, details } = failure(error);
    const text = JSON.stringify({ error: message, ...details });
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}
