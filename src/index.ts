import { createServer } from "node:http";

import { ControllerService } from "./application/controllerService.js";
import { ClaudeCodeAdapter, CustomAdapter, OpenClawAdapter } from "./adapters/placeholders.js";
import { VSCodeCopilotAdapter } from "./adapters/vscodeCopilotAdapter.js";
import { RuntimeAdapterRegistry } from "./infra/runtimeAdapterRegistry.js";
import { ApiRouter } from "./routes/api.js";
import { DiffService } from "./services/diffService.js";
import { createStateRepository } from "./services/stateRepositoryFactory.js";
import { WindowManager } from "./services/windowManager.js";
import { WorktreeManager } from "./services/worktreeManager.js";

const port = Number(process.env.PORT ?? 4317);
const stateStore = createStateRepository();
const windowManager = new WindowManager();
const worktreeManager = new WorktreeManager();
const diffService = new DiffService();
const runtimeAdapters = new RuntimeAdapterRegistry();
runtimeAdapters.register(new VSCodeCopilotAdapter(windowManager));
runtimeAdapters.register(new ClaudeCodeAdapter());
runtimeAdapters.register(new OpenClawAdapter());
runtimeAdapters.register(new CustomAdapter());

const controllerService = new ControllerService(stateStore, runtimeAdapters, worktreeManager, diffService);
const apiRouter = new ApiRouter(controllerService);

async function start(): Promise<void> {
  await stateStore.initialize();

  const server = createServer(async (request, response) => {
    try {
      await apiRouter.handle(request, response);
    } catch (error) {
      apiRouter.handleError(response, error);
    }
  });

  server.listen(port, () => {
    console.log(`open-agent-center controller listening on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start open-agent-center controller.", error);
  process.exitCode = 1;
});
