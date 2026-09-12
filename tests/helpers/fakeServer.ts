import { z } from "zod";

export interface RegisteredTool {
  name: string;
  description: string;
  shape: Record<string, z.ZodTypeAny>;
  handler: (args: any, extra?: any) => Promise<any>;
  /** Validate raw arguments against the tool's declared zod shape. */
  parse(args: unknown): ReturnType<z.ZodObject<any>["safeParse"]>;
}

/**
 * Stand-in for `McpServer` that records `server.tool(...)` registrations so the
 * declared zod shapes and the handlers can be exercised without a transport.
 */
export function createFakeServer() {
  const tools = new Map<string, RegisteredTool>();

  const server = {
    tool(
      name: string,
      description: string,
      shape: Record<string, z.ZodTypeAny>,
      handler: (args: any, extra?: any) => Promise<any>
    ) {
      if (tools.has(name)) {
        throw new Error(`tool registered twice: ${name}`);
      }
      tools.set(name, {
        name,
        description,
        shape,
        handler,
        parse: (args: unknown) => z.object(shape).safeParse(args),
      });
    },
  };

  return {
    server,
    tools,
    names: () => [...tools.keys()],
    get(name: string): RegisteredTool {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool;
    },
  };
}

export interface ApiCall {
  method: string;
  args: any[];
}

/**
 * Proxy standing in for `PaperlessAPI`: records every call and returns a
 * recognizable stub result, unless the method is overridden.
 */
export function createApiStub(
  overrides: Record<string, (...args: any[]) => any> = {}
) {
  const calls: ApiCall[] = [];

  const api = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string" || property === "then") {
          return undefined;
        }
        return (...args: any[]) => {
          calls.push({ method: property, args });
          const override = overrides[property];
          return override
            ? override(...args)
            : Promise.resolve({ stubbed: property });
        };
      },
    }
  );

  return {
    api,
    calls,
    lastCall(): ApiCall {
      if (calls.length === 0) throw new Error("no API call was recorded");
      return calls[calls.length - 1];
    },
  };
}
