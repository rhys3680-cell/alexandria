#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { watch } from 'chokidar';
import {
  Alexandria,
  addTerms,
  DEFAULT_WHISPER_MODEL,
  defaultVaultDir,
  describeError,
  dictionaryPath,
  loadDictionary,
  MODEL_NOTES,
  removeTerms,
  ensureModel,
  ensureWhisperBinary,
  findWhisperBinary,
  KNOWN_MODELS,
  loadConfig,
  MODEL_SIZES,
  retryFailedJobs,
  saveConfig,
  TransformersEmbedder,
  vendorDir,
  WHISPER_MODELS,
  type Item,
  type PipelineEvent,
  type SearchHit,
  type SearchMode,
  type ToolAccess,
  WindowsSapiSpeaker,
  guessLanguage,
  type WhisperModel,
} from '@alexandria/core';
import {
  color,
  endProgressLine,
  formatBriefing,
  formatBytes,
  formatItemDetail,
  formatItemLine,
  formatRelated,
  progressLine,
} from './ui.js';

const program = new Command();

program
  .name('alx')
  .description('Alexandria — 글과 음성을 알아서 정리하고 찾아주는 개인 보관소')
  .version('0.1.0')
  .option('--vault <dir>', '보관소 경로 (기본값: ~/Alexandria 또는 $ALEXANDRIA_VAULT)');

function vaultOption(): string | undefined {
  return program.opts<{ vault?: string }>().vault;
}

function open(): Alexandria {
  return Alexandria.open(vaultOption());
}

/** Runs `fn` with an open vault and always closes the database. */
async function withVault(fn: (alx: Alexandria) => Promise<void> | void): Promise<void> {
  const alx = open();
  try {
    await fn(alx);
  } finally {
    alx.close();
  }
}

// ------------------------------------------------------------------- init

program
  .command('init')
  .description('보관소를 만들고 설정 파일을 생성합니다')
  .action(async () => {
    const dir = vaultOption() ?? defaultVaultDir();
    const config = loadConfig(dir);
    saveConfig(config);

    await withVault(async (alx) => {
      console.log(`${color.green('보관소 준비 완료')}  ${alx.config.vaultDir}`);
      console.log(color.dim(`  항목: ${alx.vault.itemsDir}`));
      console.log(color.dim(`  설정: ${path.join(alx.vault.metaDir, 'config.json')}`));
      console.log('');
      await printDoctor(alx);
    });
  });

// -------------------------------------------------------------------- add

program
  .command('add [text...]')
  .description('텍스트나 파일을 수집합니다 (인자가 없으면 표준입력을 읽습니다)')
  .option('-f, --file <path...>', '파일에서 수집 (텍스트 또는 오디오)')
  .option('--source <source>', '출처 표시', 'manual')
  .option('--now', '수집 후 곧바로 정리까지 실행')
  .action(async (textParts: string[], options: { file?: string[]; source: string; now?: boolean }) => {
    await withVault(async (alx) => {
      const created: Item[] = [];

      for (const file of options.file ?? []) {
        const resolved = path.resolve(file);
        created.push(alx.captureFile(resolved, 'file'));
      }

      const inline = textParts.join(' ').trim();
      const piped = inline ? '' : await readStdin();
      const text = inline || piped.trim();
      if (text) {
        created.push(alx.captureText({ text, source: options.source as Item['source'] }));
      }

      if (!created.length) {
        console.error(color.red('수집할 내용이 없습니다. 텍스트를 입력하거나 --file 을 사용하세요.'));
        process.exitCode = 1;
        return;
      }

      for (const item of created) {
        console.log(`${color.green('수집됨')}  ${color.dim(item.id.slice(-6))}  ${item.media ?? `${item.body.length}자`}`);
      }

      if (options.now) {
        console.log('');
        await runQueue(alx, {});
      } else {
        console.log(color.dim(`\n대기 중인 작업 ${alx.pendingCount()}건. 'alx run' 으로 정리하세요.`));
      }
    });
  });

// -------------------------------------------------------------------- run

program
  .command('run')
  .description('대기 중인 전사·정리 작업을 실행합니다')
  .option('-n, --limit <count>', '처리할 최대 작업 수', (value) => Number.parseInt(value, 10))
  .option('--follow', '계속 대기하면서 새 작업을 처리합니다')
  .option('--interval <ms>', '--follow 일 때 확인 주기', (value) => Number.parseInt(value, 10), 3000)
  .action(async (options: { limit?: number; follow?: boolean; interval: number }) => {
    await withVault(async (alx) => {
      await runQueue(alx, { limit: options.limit });
      if (!options.follow) return;

      console.log(color.dim('새 작업을 기다립니다. Ctrl+C 로 종료.'));
      let stop = false;
      process.on('SIGINT', () => {
        stop = true;
      });
      while (!stop) {
        await delay(options.interval);
        if (alx.pendingCount() > 0) await runQueue(alx, {});
      }
    });
  });

// ------------------------------------------------------------------ watch

program
  .command('watch [dirs...]')
  .description('폴더를 감시하며 새 파일을 자동으로 수집·정리합니다')
  .option('--no-process', '수집만 하고 정리는 하지 않습니다')
  .action(async (dirs: string[], options: { process: boolean }) => {
    await withVault(async (alx) => {
      const targets = (dirs.length ? dirs : alx.config.ingest.watchDirs).map((dir) => path.resolve(dir));
      if (!targets.length) {
        console.error(
          color.red('감시할 폴더가 없습니다. 인자로 넘기거나 `alx config set ingest.watchDirs ...` 로 지정하세요.'),
        );
        process.exitCode = 1;
        return;
      }

      const accepted = new Set([...alx.config.ingest.textExtensions, ...alx.config.ingest.audioExtensions]);
      const vaultRoot = path.resolve(alx.config.vaultDir);

      for (const target of targets) console.log(`${color.cyan('감시 중')}  ${target}`);
      console.log(color.dim('Ctrl+C 로 종료.\n'));

      const watcher = watch(targets, {
        ignoreInitial: true,
        depth: 6,
        // Wait for the writer to finish before reading, or we ingest a partial file.
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
      });

      let draining = false;
      const drain = async () => {
        if (draining || !options.process) return;
        draining = true;
        try {
          await runQueue(alx, {});
        } finally {
          draining = false;
        }
      };

      watcher.on('add', (file: string) => {
        const resolved = path.resolve(file);
        // Never re-ingest our own vault.
        if (resolved.startsWith(vaultRoot)) return;
        if (!accepted.has(path.extname(resolved).toLowerCase())) return;

        try {
          const item = alx.captureFile(resolved, 'watch');
          console.log(`${color.green('수집됨')}  ${color.dim(item.id.slice(-6))}  ${path.basename(resolved)}`);
          void drain();
        } catch (error) {
          console.error(`${color.red('수집 실패')}  ${path.basename(resolved)}: ${describeError(error)}`);
        }
      });

      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          void watcher.close().then(resolve);
        });
      });
    });
  });

// --------------------------------------------------------------- ls/search

program
  .command('ls')
  .description('최근 항목을 나열합니다')
  .option('-n, --limit <count>', '개수', (value) => Number.parseInt(value, 10), 20)
  .option('--status <status>', '상태로 필터')
  .option('--tag <tag>', '태그로 필터')
  .option('--kind <kind>', '종류로 필터')
  .option('--lang <lang>', '언어로 필터')
  .option('--json', 'JSON 으로 출력')
  .action(async (options: Record<string, string> & { limit: number; json?: boolean }) => {
    await withVault((alx) => {
      const items = alx.list({
        limit: options.limit,
        status: options.status as never,
        tag: options.tag,
        kind: options.kind as never,
        lang: options.lang,
      });
      if (options.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      if (!items.length) {
        console.log(color.dim('항목이 없습니다.'));
        return;
      }
      for (const item of items) console.log(formatItemLine(item));
    });
  });

program
  .command('search <query...>')
  .description('어휘·의미 검색을 함께 사용해 찾습니다')
  .option('-n, --limit <count>', '개수', (value) => Number.parseInt(value, 10), 20)
  .option('--lexical', '어휘 검색만 사용')
  .option('--semantic', '의미 검색만 사용')
  .option('--json', 'JSON 으로 출력')
  .action(
    async (
      queryParts: string[],
      options: { limit: number; lexical?: boolean; semantic?: boolean; json?: boolean },
    ) => {
      await withVault(async (alx) => {
        const mode: SearchMode = options.lexical ? 'lexical' : options.semantic ? 'semantic' : 'auto';
        const hits = await alx.search(queryParts.join(' '), options.limit, mode);

        if (options.json) {
          console.log(JSON.stringify(hits, null, 2));
          return;
        }
        if (!hits.length) {
          console.log(color.dim('결과가 없습니다.'));
          return;
        }
        for (const hit of hits) {
          console.log(`${searchBadge(hit.via)} ${formatItemLine(hit.item)}`);
          if (hit.snippet) console.log(`       ${color.dim(hit.snippet.replace(/\s+/g, ' '))}`);
        }
      });
    },
  );

program
  .command('show <id>')
  .description('항목 하나를 자세히 봅니다 (전체 ID 또는 뒤 6자리)')
  .option('--no-related', '관련 기록을 생략합니다')
  .action(async (id: string, options: { related: boolean }) => {
    await withVault((alx) => {
      const item = resolveItem(alx, id);
      if (!item) {
        console.error(color.red(`항목을 찾을 수 없습니다: ${id}`));
        process.exitCode = 1;
        return;
      }
      console.log(formatItemDetail(item));
      if (options.related) {
        console.log(`\n${color.bold('관련 기록')}`);
        console.log(formatRelated(alx.related(item.id)));
      }
    });
  });

program
  .command('related <id>')
  .description('이 항목과 이어지는 과거 기록을 찾습니다')
  .option('-n, --limit <count>', '개수', (value) => Number.parseInt(value, 10), 5)
  .option('--json', 'JSON 으로 출력')
  .action(async (id: string, options: { limit: number; json?: boolean }) => {
    await withVault((alx) => {
      const item = resolveItem(alx, id);
      if (!item) {
        console.error(color.red(`항목을 찾을 수 없습니다: ${id}`));
        process.exitCode = 1;
        return;
      }
      const hits = alx.related(item.id, options.limit);
      if (options.json) {
        console.log(JSON.stringify(hits, null, 2));
        return;
      }
      console.log(color.dim(`${item.title ?? item.id} 와(과) 이어지는 기록\n`));
      console.log(formatRelated(hits));
    });
  });

program
  .command('rm <id>')
  .description('항목과 원본 파일을 삭제합니다')
  .action(async (id: string) => {
    await withVault((alx) => {
      const item = resolveItem(alx, id);
      if (!item || !alx.delete(item.id)) {
        console.error(color.red(`항목을 찾을 수 없습니다: ${id}`));
        process.exitCode = 1;
        return;
      }
      console.log(`${color.green('삭제됨')}  ${item.title ?? item.id}`);
    });
  });

// ------------------------------------------------------------------ today

program
  .command('today')
  .description('오늘 챙길 것들을 먼저 보여줍니다 (인자 없이 `alx` 만 쳐도 됩니다)')
  .option('--soon <days>', '"곧" 으로 볼 기간', (value) => Number.parseInt(value, 10), 7)
  .option('--json', 'JSON 으로 출력')
  .action(async (options: { soon: number; json?: boolean }) => {
    await withVault((alx) => {
      const briefing = alx.briefing({ soonDays: options.soon });
      console.log(options.json ? JSON.stringify(briefing, null, 2) : formatBriefing(briefing));
    });
  });

program
  .command('done <id> <index>')
  .description('할 일을 완료 처리합니다 (`alx today` 의 6APQFA·1 표기에서 6APQFA 와 1)')
  .option('--undo', '완료를 취소합니다')
  .action(async (id: string, index: string, options: { undo?: boolean }) => {
    await withVault((alx) => {
      const item = resolveItem(alx, id);
      if (!item) {
        console.error(color.red(`항목을 찾을 수 없습니다: ${id}`));
        process.exitCode = 1;
        return;
      }

      // Displayed 1-based, stored 0-based.
      const position = Number.parseInt(index, 10) - 1;
      const updated = alx.setTaskDone(item.id, position, !options.undo);
      if (!updated) {
        console.error(color.red(`${item.id.slice(-6)} 에 ${index}번 할 일이 없습니다.`));
        process.exitCode = 1;
        return;
      }

      const task = updated.tasks[position];
      console.log(`${options.undo ? color.yellow('되돌림') : color.green('완료')}  ${task?.text ?? ''}`);
    });
  });

// -------------------------------------------------------------------- ask

program
  .command('ask <question...>')
  .description('앱에 붙은 모델과 대화합니다')
  .option('--tools <level>', '도구 수준: none | web | vault', 'none')
  .option('--item <id...>', '이 항목들을 문맥으로 넣습니다')
  .option('--search <query>', '검색 상위 결과를 문맥으로 넣습니다')
  .option('-n, --context <count>', '--search 로 넣을 개수', (value) => Number.parseInt(value, 10), 5)
  .option('--save', '질문과 답변을 보관소에 저장합니다')
  .option('--speak', '답변을 소리로 읽어줍니다')
  .action(
    async (
      questionParts: string[],
      options: {
        tools: string;
        item?: string[];
        search?: string;
        context: number;
        save?: boolean;
        speak?: boolean;
      },
    ) => {
      const tools = options.tools as ToolAccess;
      if (!['none', 'web', 'vault'].includes(tools)) {
        console.error(color.red(`알 수 없는 도구 수준: ${options.tools}. none | web | vault 중 하나여야 합니다.`));
        process.exitCode = 1;
        return;
      }

      await withVault(async (alx) => {
        const question = questionParts.join(' ');
        const context: Item[] = [];

        for (const id of options.item ?? []) {
          const item = resolveItem(alx, id);
          if (item) context.push(item);
          else console.error(color.yellow(`항목을 찾지 못해 건너뜁니다: ${id}`));
        }
        if (options.search) {
          const hits = await alx.search(options.search, options.context);
          context.push(...hits.map((hit) => hit.item));
        }

        if (context.length) {
          console.log(color.dim(`문맥 ${context.length}건: ${context.map((i) => i.id.slice(-6)).join(', ')}\n`));
        }
        if (tools !== 'none') console.log(color.dim(`도구: ${tools} (호출 비용이 올라갑니다)\n`));

        const result = await alx.ask({
          prompt: question,
          tools,
          context,
          // Streamed straight to stdout so a long answer is readable as it lands.
          onText: (chunk) => process.stdout.write(chunk),
        });

        console.log(color.dim(`\n\n비용 환산 $${result.costUsd.toFixed(4)} · ${(result.durationMs / 1000).toFixed(1)}s`));

        if (options.speak) {
          const speaker = new WindowsSapiSpeaker();
          const problem = await speaker.check();
          if (problem) console.error(color.yellow(problem));
          else await speaker.speak(result.text, { language: guessLanguage(result.text) });
        }

        if (options.save) {
          const item = alx.saveAnswer(question, result.text);
          console.log(`${color.green('저장됨')}  ${item.id.slice(-6)}  ${color.dim('정리는 대기열에서 진행됩니다.')}`);
        }
      });
    },
  );

// ------------------------------------------------------------------- dict

const dict = program
  .command('dict')
  .description('자주 쓰는 이름·용어 사전 (전사 정확도를 크게 올립니다)');

dict
  .command('list', { isDefault: true })
  .description('사전을 봅니다')
  .action(async () => {
    const vaultDir = loadConfig(vaultOption()).vaultDir;
    const terms = loadDictionary(vaultDir);
    if (!terms.length) {
      console.log(color.dim('사전이 비어 있습니다. `alx dict add <용어...>` 로 추가하세요.'));
      return;
    }
    for (const term of terms) console.log(`  ${term}`);
    console.log(color.dim(`\n  ${terms.length}개 · ${dictionaryPath(vaultDir)}`));
  });

dict
  .command('add <terms...>')
  .description('용어를 추가합니다')
  .action(async (terms: string[]) => {
    const vaultDir = loadConfig(vaultOption()).vaultDir;
    const all = addTerms(vaultDir, terms);
    console.log(`${color.green('추가됨')}  ${terms.join(', ')}  ${color.dim(`(총 ${all.length}개)`)}`);
    console.log(color.dim('다음 전사부터 반영됩니다. 기존 항목은 `alx retry` 로 다시 처리할 수 있습니다.'));
  });

dict
  .command('remove <terms...>')
  .description('용어를 뺍니다')
  .action(async (terms: string[]) => {
    const vaultDir = loadConfig(vaultOption()).vaultDir;
    const all = removeTerms(vaultDir, terms);
    console.log(`${color.green('삭제됨')}  ${terms.join(', ')}  ${color.dim(`(총 ${all.length}개)`)}`);
  });

// ------------------------------------------------------------- maintenance

program
  .command('stats')
  .description('보관소 현황을 봅니다')
  .action(async () => {
    await withVault((alx) => {
      const stats = alx.stats();
      const total = Object.values(stats.byStatus).reduce((sum, count) => sum + count, 0);
      console.log(`${color.bold('항목')}  ${total}건`);
      for (const [status, count] of Object.entries(stats.byStatus).sort()) {
        console.log(`  ${status.padEnd(14)} ${count}`);
      }
      console.log(`${color.bold('대기 작업')}  ${stats.pending}건`);
      console.log(
        `${color.bold('의미 검색')}  ${stats.semantic ? `켜짐 · 벡터 ${stats.embedded}건` : color.dim('꺼짐')}`,
      );
      console.log(`${color.bold('정리 비용 환산 누계')}  $${stats.totalCostUsd.toFixed(4)}`);
      console.log(color.dim('  구독 로그인 상태라면 실제 청구가 아니라 사용량 한도 소모량의 환산치입니다.'));

      const tags = alx.tags(12);
      if (tags.length) {
        console.log(`${color.bold('태그')}  ${tags.map((entry) => `#${entry.tag}(${entry.count})`).join(' ')}`);
      }
    });
  });

program
  .command('reindex')
  .description('마크다운 파일로부터 검색 색인을 다시 만듭니다')
  .action(async () => {
    await withVault((alx) => {
      const count = alx.reindex((done, total) => progressLine(`색인 중 ${done}/${total}`));
      endProgressLine();
      console.log(`${color.green('색인 완료')}  ${count}건`);
    });
  });

program
  .command('retry')
  .description('실패한 작업을 다시 대기열에 넣습니다')
  .action(async () => {
    await withVault((alx) => {
      const count = retryFailedJobs(alx.db);
      console.log(`${color.green('재시도 대기')}  ${count}건`);
    });
  });

program
  .command('doctor')
  .description('실행 환경을 점검합니다')
  .action(async () => {
    await withVault(async (alx) => {
      await printDoctor(alx);
    });
  });

// ------------------------------------------------------------------ setup

const setup = program.command('setup').description('의존 도구를 설치합니다');

setup
  .command('whisper')
  .description('whisper.cpp 실행 파일과 모델을 내려받습니다')
  .option('-m, --model <name>', `모델 (${WHISPER_MODELS.join(', ')})`, DEFAULT_WHISPER_MODEL)
  .option('--list', '고를 수 있는 모델을 보여줍니다')
  .action(async (options: { model: string; list?: boolean }) => {
    if (options.list) {
      for (const name of WHISPER_MODELS) {
        const marker = name === DEFAULT_WHISPER_MODEL ? color.green(' ←기본') : '';
        console.log(`  ${name.padEnd(16)} ${MODEL_SIZES[name].padStart(8)}  ${color.dim(MODEL_NOTES[name] ?? '')}${marker}`);
      }
      return;
    }

    const model = options.model as WhisperModel;
    if (!WHISPER_MODELS.includes(model)) {
      console.error(color.red(`알 수 없는 모델: ${model}. 가능한 값: ${WHISPER_MODELS.join(', ')}`));
      process.exitCode = 1;
      return;
    }

    const config = loadConfig(vaultOption());
    const vendorDir = path.join(config.vaultDir, '.alexandria', 'vendor');
    fs.mkdirSync(vendorDir, { recursive: true });

    console.log(color.cyan('whisper.cpp 실행 파일 확인 중...'));
    const binary = await ensureWhisperBinary(vendorDir, (received, total) =>
      progressLine(`  내려받는 중 ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}`),
    );
    endProgressLine();

    if (binary.instructions) {
      console.log(color.yellow(binary.instructions));
    } else {
      console.log(`${color.green('실행 파일')}  ${binary.path}`);
      config.stt.binPath = binary.path;
    }

    console.log(color.cyan(`모델 '${model}' 확인 중... (${MODEL_SIZES[model]})`));
    const modelPath = await ensureModel(vendorDir, model, (received, total) =>
      progressLine(`  내려받는 중 ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}`),
    );
    endProgressLine();
    console.log(`${color.green('모델')}  ${modelPath}`);
    config.stt.modelPath = modelPath;

    saveConfig(config);
    console.log(color.dim('\n설정에 저장했습니다. `alx doctor` 로 확인하세요.'));
  });

setup
  .command('embeddings')
  .description('의미 검색용 임베딩 모델을 내려받고 켭니다')
  .option('-m, --model <name>', '모델 이름')
  .option('--list', '고를 수 있는 모델을 보여줍니다')
  .action(async (options: { model?: string; list?: boolean }) => {
    if (options.list) {
      for (const [name, info] of Object.entries(KNOWN_MODELS)) {
        console.log(`  ${name.padEnd(34)} ${info.download.padStart(8)}  ${info.dims}d  ${color.dim(info.note)}`);
      }
      console.log(color.dim('\n  모델을 바꾸면 기존 벡터는 무시되고 자동으로 다시 임베딩합니다.'));
      return;
    }

    const config = loadConfig(vaultOption());
    if (options.model) config.search.model = options.model;
    config.search.semantic = true;

    console.log(color.cyan(`임베딩 모델 '${config.search.model}' 준비 중...`));
    const embedder = new TransformersEmbedder(config.search, vendorDir(config.vaultDir), (progress) => {
      if (progress.total) {
        progressLine(`  ${progress.file}  ${formatBytes(progress.loaded ?? 0)} / ${formatBytes(progress.total)}`);
      }
    });

    const problem = await embedder.check();
    endProgressLine();
    if (problem) {
      console.error(color.red(problem));
      process.exitCode = 1;
      return;
    }
    console.log(color.green('모델 준비 완료'));

    // Saved before opening the vault so the pipeline sees semantic search on.
    saveConfig(config);

    await withVault(async (alx) => {
      const queued = alx.embedMissing();
      if (!queued) {
        console.log(color.dim('임베딩할 기존 항목이 없습니다.'));
        return;
      }
      console.log(color.dim(`기존 항목 ${queued}건을 임베딩합니다.`));
      await runQueue(alx, {});
    });
  });

program
  .command('embed')
  .description('아직 임베딩이 없는 항목을 처리합니다')
  .action(async () => {
    await withVault(async (alx) => {
      if (!alx.config.search.semantic) {
        console.error(color.red('의미 검색이 꺼져 있습니다. `alx setup embeddings` 를 먼저 실행하세요.'));
        process.exitCode = 1;
        return;
      }
      const queued = alx.embedMissing();
      console.log(`${queued}건을 대기열에 넣었습니다.`);
      if (queued) await runQueue(alx, {});
    });
  });

// ----------------------------------------------------------------- config

const configCommand = program.command('config').description('설정을 보거나 바꿉니다');

configCommand
  .command('get [key]')
  .description('설정값을 출력합니다 (예: llm.model)')
  .action((key?: string) => {
    const config = loadConfig(vaultOption());
    if (!key) {
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    const value = readPath(config as unknown as Record<string, unknown>, key);
    console.log(value === undefined ? color.dim('(설정되지 않음)') : JSON.stringify(value, null, 2));
  });

configCommand
  .command('set <key> <value>')
  .description('설정값을 바꿉니다 (예: llm.model sonnet)')
  .action((key: string, value: string) => {
    const config = loadConfig(vaultOption());
    writePath(config as unknown as Record<string, unknown>, key, parseValue(value));
    saveConfig(config);
    console.log(`${color.green('저장됨')}  ${key} = ${JSON.stringify(readPath(config as unknown as Record<string, unknown>, key))}`);
  });

// ------------------------------------------------------------------ shared

async function runQueue(alx: Alexandria, options: { limit?: number }): Promise<void> {
  const pending = alx.pendingCount();
  if (!pending) {
    console.log(color.dim('대기 중인 작업이 없습니다.'));
    return;
  }

  const summary = await alx.processPending({
    limit: options.limit,
    onEvent: (event) => reportEvent(event),
  });

  console.log(
    `${color.green('완료')}  처리 ${summary.processed}건` +
      (summary.failed ? color.red(`  실패 ${summary.failed}건`) : '') +
      color.dim(`  비용 환산 $${summary.costUsd.toFixed(4)}`),
  );
}

function reportEvent(event: PipelineEvent): void {
  const label = event.type === 'job:error' ? '' : (event as { job: { type: string } }).job.type;
  switch (event.type) {
    case 'job:start':
      progressLine(color.dim(`  ${label} ${event.item.id.slice(-6)} 처리 중...`));
      break;
    case 'job:done':
      endProgressLine();
      console.log(`  ${color.green('✓')} ${label.padEnd(10)} ${formatItemLine(event.item)}`);
      break;
    case 'job:error':
      endProgressLine();
      console.log(
        `  ${color.red('✗')} ${event.itemId.slice(-6)} ${event.error}` +
          (event.willRetry ? color.dim(' (재시도 예정)') : ''),
      );
      break;
  }
}

/** Shows which index found a result, since a semantic hit shares no words. */
function searchBadge(via: SearchHit['via']): string {
  if (via === 'semantic') return color.magenta('의미');
  if (via === 'both') return color.green('둘다');
  return color.dim('어휘');
}

async function printDoctor(alx: Alexandria): Promise<void> {
  const checks = await alx.doctor();
  for (const check of checks) {
    console.log(`${check.ok ? color.green('OK  ') : color.red('없음')}  ${check.name}`);
    if (check.detail) console.log(color.dim(`      ${check.detail}`));
  }
}

/** Accepts a full id or the 6-character suffix shown in listings. */
function resolveItem(alx: Alexandria, idOrSuffix: string): Item | undefined {
  const direct = alx.get(idOrSuffix);
  if (direct) return direct;

  const rows = alx.db
    .prepare('select id from items where id like ? order by created desc limit 2')
    .all(`%${idOrSuffix.toUpperCase()}`);
  if (rows.length !== 1) return undefined;
  return alx.get(String((rows[0] as { id: string }).id));
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

function readPath(target: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((current, part) => {
    if (current && typeof current === 'object') return (current as Record<string, unknown>)[part];
    return undefined;
  }, target);
}

function writePath(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  const last = parts.pop();
  if (!last) return;

  let cursor: Record<string, unknown> = target;
  for (const part of parts) {
    const next = cursor[part];
    if (!next || typeof next !== 'object') cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[last] = value;
}

/** `12` and `["a","b"]` become real values; anything else stays a string. */
function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bare `alx` opens the briefing rather than printing help — showing you what
// needs attention is the point of the app.
const argv = process.argv.length > 2 ? process.argv : [...process.argv, 'today'];

program.parseAsync(argv).catch((error: unknown) => {
  console.error(color.red(describeError(error)));
  process.exitCode = 1;
});
