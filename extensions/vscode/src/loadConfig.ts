import { ContinueConfig, IDE, ILLM } from "core";
import * as fs from "fs";
import { Agent, ProxyAgent, fetch } from "undici";
import * as vscode from "vscode";
import { webviewRequest } from "./debugPanel";
import { VsCodeIde, loadFullConfigNode } from "./ideProtocol";
const tls = require("tls");

const outputChannel = vscode.window.createOutputChannel(
  "Continue - LLM Prompt/Completion"
);

class VsCodeConfigHandler {
  savedConfig: ContinueConfig | undefined;

  reloadConfig() {
    this.savedConfig = undefined;
  }

  async loadConfig(ide: IDE): Promise<ContinueConfig> {
    if (this.savedConfig) {
      return this.savedConfig;
    }
    this.savedConfig = await loadFullConfigNode(ide);
    return this.savedConfig;
  }
}

export const configHandler = new VsCodeConfigHandler();

const TIMEOUT = 7200; // 7200 seconds = 2 hours

export async function llmFromTitle(title?: string): Promise<ILLM> {
  let config = await configHandler.loadConfig(new VsCodeIde());

  if (title === undefined) {
    const resp = await webviewRequest("getDefaultModelTitle");
    if (resp?.defaultModelTitle) {
      title = resp.defaultModelTitle;
    }
  }

  let llm = title
    ? config.models.find((llm) => llm.title === title)
    : config.models[0];
  if (!llm) {
    // Try to reload config
    configHandler.reloadConfig();
    config = await configHandler.loadConfig(new VsCodeIde());
    llm = config.models.find((llm) => llm.title === title);
    if (!llm) {
      throw new Error(`Unknown model ${title}`);
    }
  }

  // Since we know this is happening in Node.js, we can add requestOptions through a custom agent
  const ca = [...tls.rootCertificates];
  const customCerts =
    typeof llm.requestOptions?.caBundlePath === "string"
      ? [llm.requestOptions?.caBundlePath]
      : llm.requestOptions?.caBundlePath;
  if (customCerts) {
    ca.push(
      ...customCerts.map((customCert) => fs.readFileSync(customCert, "utf8"))
    );
  }

  let timeout = (llm.requestOptions?.timeout || TIMEOUT) * 1000; // measured in ms

  const agent =
    llm.requestOptions?.proxy !== undefined
      ? new ProxyAgent({
          connect: {
            ca,
            rejectUnauthorized: llm.requestOptions?.verifySsl,
            timeout,
          },
          uri: llm.requestOptions?.proxy,
          bodyTimeout: timeout,
          connectTimeout: timeout,
          headersTimeout: timeout,
        })
      : new Agent({
          connect: {
            ca,
            rejectUnauthorized: llm.requestOptions?.verifySsl,
            timeout,
          },
          bodyTimeout: timeout,
          connectTimeout: timeout,
          headersTimeout: timeout,
        });

  llm._fetch = async (input, init) => {
    const headers: { [key: string]: string } =
      llm!.requestOptions?.headers || {};
    for (const [key, value] of Object.entries(init?.headers || {})) {
      headers[key] = value as string;
    }

    const resp = await fetch(input, {
      ...init,
      dispatcher: agent,
      headers,
    });

    if (!resp.ok) {
      let text = await resp.text();
      if (resp.status === 404 && !resp.url.includes("/v1")) {
        text =
          "This may mean that you forgot to add '/v1' to the end of your 'apiBase' in config.json.";
      }
      throw new Error(
        `HTTP ${resp.status} ${resp.statusText} from ${resp.url}\n\n${text}`
      );
    }

    return resp;
  };

  llm.writeLog = async (log: string) => {
    outputChannel.appendLine(
      "=========================================================================="
    );
    outputChannel.appendLine(
      "=========================================================================="
    );

    outputChannel.append(log);
  };

  return llm;
}
