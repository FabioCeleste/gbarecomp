# WEB_WASM_SESSION_2026-09-13 — tail calls implementadas, PK recompilado do zero, primeiro teste em navegador

**Data:** 2026-09-13
**Branch:** `feat/web-wasm-tailcall` (repo) · `feat/web-wasm-tailcall` (submódulo `external/arm-recomp-core`)
**Status:** tail calls garantidas **implementadas e validadas**. Navegador: modo headless roda com
paridade total com o nativo; modo janela **só roda** com renderer por software do SDL, sem
OffscreenCanvas e sem áudio (validado por experimento, **ainda não aplicado no código**).

Documentos relacionados (ler nesta ordem se for continuar):

1. este documento — visão geral e estado atual;
2. `docs/WEB_WASM_TAILCALL_IMPLEMENTATION.md` — o plano executado (§12: execução real e desvios);
3. `docs/WEB_WASM_EXPERIMENTS.md` — diário técnico do port (§11: primeiro teste em navegador);
4. `docs/WEB_WASM_TAILCALL_LESSONS.md` — erros da sessão de protótipo;
5. `docs/WEB_WASM_PORT.md` — levantamento original;
6. `docs/RECOMP_LOG_POKEMON_EMERALD.md` — como o `output/pk` foi configurado.

---

## 0. Resumo em 12 linhas

1. O plano `WEB_WASM_TAILCALL_IMPLEMENTATION.md` foi aplicado **sem mudanças nos diffs** (T1–T8).
2. Todas as validações V1–V8 passaram com **os mesmos números do protótipo**. V9 (Windows) não foi feita.
3. O nativo continua **idêntico**: texto gerado (depois de expandir as macros), objeto `-O3` e overlays gcc/tcc.
4. No wasm, o PK roda 1.800 e 10.800 frames (multithread e single-thread, e com pilha do V8 de 128 KB)
   com **o mesmo estado final, os mesmos misses e as mesmas instruções interpretadas** do nativo antigo.
5. O PK foi **recompilado do zero** (99.274 funções) e o runtime nativo e web foram refeitos do zero.
6. Foi criada uma casca de teste web: `packaging/web/` (build, página, servidor COOP/COEP, `main.cpp`).
7. **Navegador, headless:** 1.800 frames, `exit=0`, paridade exata com o nativo.
8. **Navegador, janela (padrão):** falha com `getContext … transferred its control to offscreen`.
9. Causa: o port SDL2 do Emscripten faz **tudo que toca o canvas e o áudio na thread principal**, o que
   é incompatível com `OFFSCREENCANVAS_SUPPORT` e com GL a partir do worker.
10. Experimento: **sem OffscreenCanvas + `SDL_RENDER_DRIVER=software` + `SDL_AUDIODRIVER=dummy`** →
    600 frames apresentados, `exit=0`.
11. Áudio do SDL2 quebra no worker por um bug do port (`EM_ASM_INT` em vez de `MAIN_THREAD_EM_ASM_INT`).
12. Próximo passo recomendado: aplicar o experimento 10 no código (seção 6, passo 1).

---

## 1. Ambiente

| Item | Valor |
|---|---|
| Host | macOS (Darwin 25.6), Apple Silicon, 10 núcleos |
| Emscripten | 6.0.9 (`source ~/emsdk/emsdk_env.sh`) |
| Node usado pelo emsdk | 24.19.0 (o plano citava 24.14.1) |
| Python | 3.9.6 (o do macOS) |
| tcc | 0.9.28rc `mob@0fb54300`, compilado do fonte em `gbarecomp-tailcall-work/tcc` |
| SDL2 (port Emscripten) | `SDL-release-2.32.10` (`~/emsdk/upstream/emscripten/cache/ports/sdl2/`) |
| Navegador de teste | Google Chrome headless (`--headless=new`, WebGL via SwiftShader) |
| ROM | `roms/pk.gba` — Pokémon Emerald (USA) BPEE, SHA-1 `f3ae088181bf583e55daf962a92bb46f4f1d07b7` |
| BIOS | `bios/gba_bios.bin`, SHA-1 `300c20df6731a33952ded8c436f7f186d25d3492` |

O volume é exFAT: o git imprime `error: non-monotonic index … ._pack-*.idx` em todo comando
(arquivos AppleDouble `._*`). É ruído; commits funcionaram. **Não** foi rodado `dot_clean`.

---

## 2. O que foi feito (em ordem)

### 2.1 Branches

- `git checkout -b feat/web-wasm-tailcall` no repo e no submódulo (que estava em HEAD destacado `763b922`).

### 2.2 Referência congelada antes de editar (T0)

- Configurado `build-base/` com o **código antigo**; `gba_recompile` antigo copiado para
  `gbarecomp-tailcall-work/gba_recompile_base`.
- BIOS antigo e PK antigo gerados em `gbarecomp-tailcall-work/old/{bios,pk/generated}`.
- `build-base` reconfigurado com o BIOS antigo, build completo, `ctest` **29/29**.
- Projeto PK antigo (headers antigos copiados pelo `cli.copy_framework`) compilado nativo e linkado:
  `gbarecomp-tailcall-work/link/pk_native_old`.
- Runs de referência nativos (`GBARECOMP_SELFHEAL_RECOMPILE=0 --no-window`):
  - 1.800 frames: `final_pc=0x080008ca steps=4160`, 36 misses, 38.016.147 instruções interpretadas;
  - 10.800 frames: `final_pc=0x080008c6 steps=11512`, 54 misses, 269.727.239 instruções interpretadas.

### 2.3 Limpeza pedida ("começar do zero")

Apagados: `output/pk` (inteiro), `build/`, `build-wasm/`, `build-wasm-bios/`, `build-wasm-mt/`,
`build-wasm-sdl/`, `build-wasm-tc/`, `build-wasm-configure.log` e os `._build*` correspondentes.
O `output/pk/game.toml` (escrito à mão) foi salvo antes e restaurado.

### 2.4 Implementação (T1–T7)

Diffs do plano extraídos do próprio documento e aplicados com `patch` (todos limpos, sem `.rej`):

| Arquivo | Mudança |
|---|---|
| `external/arm-recomp-core/profiles/armv4t_gba/arm_codegen.cpp` | emissão de `GBARECOMP_TAIL_CALL/DISPATCH/DISPATCH_WITH_EXCHANGE/SWI` |
| `src/recompile/emit_function.cpp` | fall-through vira `GBARECOMP_TAIL_DISPATCH` |
| `src/armv4t/runtime_arm.h` | macros (nativo = texto antigo; Emscripten = `musttail`), `g_runtime_tail_arg`, `#error` sem `-mtail-call` |
| `src/armv4t/runtime_arm.cpp` | `dispatch_resolve`, `runtime_dispatch_tail`, `runtime_dispatch_with_exchange_tail`, `swi_enter`, `runtime_swi_tail` |
| `src/runtime/overlay_runtime_arm.h` | só a expansão nativa das macros (ABI do overlay continua **5**) |
| `CMakeLists.txt` | `-mtail-call` em compile e link sob `EMSCRIPTEN` (logo após o bloco `if(MSVC)`) |
| `cmake/runtime.cmake.in` | idem para `gbarecomp_add_runtime_target` |
| `tools/cli.py` | idem no template do projeto exportado |
| `tests/codegen/gen_codegen_tests.cpp` | asserção de forma: macro só como instrução inteira em linha própria; falha se não houver nenhuma |

### 2.5 Regeneração do zero (T8)

- `build/` novo (Release, `GBARECOMP_COMPILER_CACHE=OFF`) com o código novo.
- BIOS novo em `build/generated_bios/` (**nunca** em `src/runtime/generated_bios/`).
- `output/pk` regerado com `tools/cli.py build … --config output/pk/game.toml --force`:
  `discovered 99274 functions (arm=110 thumb=99164 …)`, `codegen shards: 64`, template com `-mtail-call`.
- `build/` reconfigurado com o BIOS novo e compilado inteiro.

### 2.6 Builds wasm

| Pasta | Conteúdo |
|---|---|
| `build-wasm-mt/` | runtime wasm `-pthread -mtail-call`, SDL2-mt, BIOS novo |
| `build-wasm-st/` | runtime wasm single-thread, SDL2, BIOS novo |
| `output/pk/build-wasm-mt/`, `output/pk/build-wasm-st/` | lib do jogo em wasm |
| `output/pk/web/` | bundle de navegador **com** `OFFSCREENCANVAS_SUPPORT` (o que dá o erro da janela) |
| `output/pk/web-noocs/` | bundle experimental **sem** OffscreenCanvas (fora do git, pode apagar) |
| `gbarecomp-tailcall-work/link/pk_{mt,st}.js` | binários node para o V8 (`NODERAWFS`) |

### 2.7 Casca web (`packaging/web/`, novo)

| Arquivo | O que faz |
|---|---|
| `build_web.sh <projeto> <BIOS gerado> [rom] [bios]` | builda runtime wasm MT + lib do jogo + link `PROXY_TO_PTHREAD`; copia página, ROM, BIOS; grava `rom_sha1.js`. Aborta se o BIOS gerado não for achado, se SDL2 não for achado ou se o `CMakeLists.txt` do projeto não tiver `-mtail-call` |
| `index.html` | botão Start; carrega ROM/BIOS por `fetch` para `/data/` (MEMFS) no `preRun`; passa `--rom-sha1`; log do runtime na página **e** no `console`; query params `args`, `env`, `rom`, `bios`, `sha1`, `autostart=1` |
| `serve.py <dir> [porta]` | servidor local com COOP/COEP (necessário para `SharedArrayBuffer`), `application/wasm`, sem cache |
| `main.cpp` | `main()` mínimo que chama `gbarecomp::run_game` (a lib do jogo não tem `main`) |

### 2.8 Commits (locais, **nada foi enviado**)

| Repo | Commit | Conteúdo |
|---|---|---|
| submódulo | `a8802bb` | só `arm_codegen.cpp` |
| gbarecomp | `0b166f8` | compatibilidade Python 3.9 em `tools/cli.py` (mudança que já existia, commitada separada) |
| gbarecomp | `1b13037` | T2–T7 + ponteiro do submódulo + docs `WEB_WASM_*` e `RECOMP_LOG_POKEMON_EMERALD.md` |
| gbarecomp | `a2c6d94` | `packaging/web/` |

**Antes de dar push na branch do gbarecomp, publicar o commit `a8802bb` do submódulo** (remoto
`github.com/mstan/arm-recomp-core`); senão o ponteiro aponta para um commit inexistente no remoto.

Este documento (`WEB_WASM_SESSION_2026-09-13.md`) ainda **não** foi commitado.

---

## 3. Resultados das validações

### 3.1 Tail calls (critérios de aceite do plano)

| Verificação | Esperado (protótipo) | Obtido |
|---|---|---|
| V1 `ctest` | 29/29 | 29/29 ✅ |
| V1 `codegen_tests` | 131/131, >0 tail transfers | 131/131, `24 guarded trace sites and 18 tail transfers` ✅ |
| V2 A/B textual BIOS | `files=4 differing=0 macros=1511` | idem ✅ |
| V2 A/B textual PK | `files=67 differing=0 macros=168341` | idem ✅ |
| V3 objeto nativo shard 000 `-O3` | idêntico (266.975 linhas) | idêntico (266.975 linhas) ✅ |
| V4 overlay c++ | idêntico | idêntico (61 linhas) ✅ |
| V4 overlay tcc | idêntico | idêntico (272 linhas, rótulo de arquivo normalizado) ✅ |
| V6 `return_call` runtime / BIOS / shard 000 | 3 / ~1204 / ~2138 | 3 / 1204 / 2138 ✅ |
| V7 sem `-mtail-call` | `#error` | `#error "gbarecomp: generated code needs guaranteed tail calls…"` ✅ |
| V7 com `-mtail-call` | `return_call=1` | 1 ✅ |
| V8 MT/ST × 1.800/10.800 × nativo | assinatura e `.toml.frag` idênticos | idênticos (40 e 58 linhas de assinatura) ✅ |
| V8 ST 10.800 `--stack-size=128` | passa | passa ✅ |
| V8 `RangeError` | nenhum | nenhum; todos `exit=0` ✅ |
| `GBA_OVERLAY_ABI_VERSION` | 5 | 5 ✅ |
| Edição em `generated/` ou `src/runtime/generated_bios/` | nenhuma | nenhuma ✅ |
| V9 Windows (MinGW + tcc empacotado) | — | **não executado** (sem Windows) |

Tamanhos: `pk_mt.wasm` 78.024.717 bytes, `pk_st.wasm` 77.962.180 bytes, bundle de navegador
`game.wasm` 80.309.833 bytes (com `--profiling-funcs`).

### 3.2 Navegador

| Cenário | Bundle | Resultado |
|---|---|---|
| `?args=--no-window --frames 1800&env=GBARECOMP_SELFHEAL_RECOMPILE=0` | `web` | ✅ `exit=0`; `final_pc=0x080008ca steps=4160`, `pal/vram/oam_nonzero` 975/26066/600, 36 misses, 38.016.147 instruções, lista de 36 PCs com contagens — **tudo idêntico ao nativo** |
| padrão (janela) | `web` (com OffscreenCanvas) | ❌ `InvalidStateError: Failed to execute 'getContext' on 'HTMLCanvasElement': Cannot get context from a canvas that has transferred its control to offscreen.` |
| padrão (janela) | `web-noocs` | ❌ `worker sent an error! … Cannot read properties of undefined (reading 'createShader')` |
| `--window --frames 600`, `SDL_RENDER_DRIVER=software` | `web-noocs` | ❌ vídeo abre (`host_window: renderer=software … vsync=yes`), depois `… (reading 'audioContext')` no worker |
| `--window --frames 600`, `SDL_RENDER_DRIVER=software`, `SDL_AUDIODRIVER=dummy`, `GBARECOMP_SELFHEAL_RECOMPILE=0` | `web-noocs` | ✅ `ppu_frames=600 frames_presented=600`, 29 misses, `exit=0` |

URL para reproduzir o cenário que funciona (servindo `output/pk/web-noocs`):

```
http://127.0.0.1:8080/?env=SDL_RENDER_DRIVER=software,SDL_AUDIODRIVER=dummy,GBARECOMP_SELFHEAL_RECOMPILE=0
```

---

## 4. Principais aprendizados

### 4.1 Técnicos

1. **O plano estava correto e completo.** Diffs aplicaram limpo e todos os números bateram com o
   protótipo. Provar "nativo inalterado" por texto (V2) e por objeto (V3/V4) foi rápido e forte.
2. **Com a pilha resolvida, o núcleo é determinístico entre nativo, node e navegador.** Mesmo PC
   final, mesmos contadores e a mesma lista de PCs interpretados com as mesmas contagens. Isso torna
   o nativo um oráculo confiável para depurar a web.
3. **O port SDL2 do Emscripten não é "pthread-aware" para vídeo nem áudio.**
   - Renderer por software: `Emscripten_UpdateWindowFramebuffer` usa `MAIN_THREAD_EM_ASM` +
     `Browser.createContext(Module['canvas'])` (`src/video/emscripten/SDL_emscriptenframebuffer.c:82`)
     → exige o canvas **na thread principal**.
   - Renderer GLES2: `eglCreateContext` é `__proxy: 'sync'` (`src/lib/libegl.js:317`) → o contexto
     WebGL nasce na thread principal, e as chamadas GL feitas pelo worker não têm `GLctx` → `createShader`
     de `undefined`.
   - Áudio: `SDL_emscriptenaudio.c:273` lê `SDL2.audioContext.sampleRate` com `EM_ASM_INT` (roda no
     worker, onde `Module['SDL2']` não existe); o resto do arquivo usa `MAIN_THREAD_EM_ASM`.
   - Conclusão: com `PROXY_TO_PTHREAD`, **`OFFSCREENCANVAS_SUPPORT` é incompatível com o SDL2 port**, e
     o renderer GL do SDL não funciona a partir do worker. O que funciona hoje é renderer por software
     com o canvas na thread principal (um proxy síncrono por frame).
4. **O SDL2 lê hints de variáveis de ambiente** (`SDL_RENDER_DRIVER`, `SDL_AUDIODRIVER`), e o
   `Module.ENV` preenchido no `preRun` chega ao `getenv` dentro da pthread. Isso permite testar
   variações de host **sem recompilar nem relinkar** — só mudando a URL.
5. **`FS.writeFile` no `preRun` + `addRunDependency`** funciona com `PROXY_TO_PTHREAD`: o `main()` no
   worker enxerga os arquivos em `/data/`.
6. **O runtime cai no renderer por software em silêncio.** Em `host_window.cpp:1150`, se o renderer
   acelerado falha e vsync não foi pedido, não há log da falha (só o `renderer=software` depois).
   Isso escondeu por que o caminho de framebuffer foi usado.
7. **`--profiling-funcs`** deixa nomes de função no `.wasm` (stack traces legíveis no navegador) por
   custo pequeno (~2 MB).
8. **Chrome headless serve como teste automatizado de navegador:** `--headless=new --use-angle=swiftshader
   --enable-unsafe-swiftshader --enable-logging=stderr --remote-debugging-port=0` + página que espelha
   o log no `console` + `?autostart=1`. No macOS, sem `timeout`: `perl -e 'alarm shift; exec @ARGV' N …`.
9. `cycles=62191750` apareceu **igual** em 600, 1.800 e 10.800 frames. Confirma a observação do
   `LESSONS.md` §3.8: não usar esse campo como medida de progresso até entender o contador.

### 4.2 De processo (erros e cuidados desta sessão)

1. **Pastas de build separadas para baseline e código novo** (`build-base` × `build`). O plano reusava
   `build-base` em T8, o que sobrescreveria as libs antigas usadas no link de referência.
2. **V3 sem `git stash`:** usar os headers antigos que o `cli.copy_framework` já copiou para o projeto
   de referência evita mexer na árvore de trabalho.
3. **V4 com tcc:** se os dois `.c` estão em pastas diferentes, o objdump do tcc põe o caminho no rótulo
   (`<oldshim/X.c+0x4000>`). A primeira comparação "falhou" por isso; normalizar o caminho resolveu.
   **Sempre olhar o `diff` antes de concluir** — nem sucesso nem falha às cegas.
4. **zsh de novo:** `PIPESTATUS` não existe no zsh e, com `set -u`, abortou a metade positiva do V7.
   Scripts de validação só em `bash`.
5. **`cd` dentro de um comando mudou o diretório da sessão** (um `grep` feito em `output/pk/web`).
   Usar caminhos absolutos ou subshell.
6. **Extrair os diffs do próprio documento** (regex nos blocos ```diff) e `patch --dry-run` antes de
   aplicar evitou retrabalho e garantiu fidelidade ao plano.
7. **Commit parcial de arquivo sem modo interativo:** separar hunks do `git diff` com script e aplicar
   com `git apply --cached` (usado para commitar só a correção Python 3.9 do `cli.py`).
8. **Testar hipóteses baratas antes de escrever código:** três relinks/URLs (minutos) eliminaram duas
   direções e provaram uma, em vez de implementar um host WebGL às cegas.

---

## 5. Bugs e pendências atuais

Severidade: **B** = bloqueia uso normal no navegador · **M** = importante · **I** = informativo/pré-existente.

| ID | Sev. | Descrição | Evidência / onde |
|---|---|---|---|
| WEB-1 | **B** | Bundle padrão (`build_web.sh`) usa `OFFSCREENCANVAS_SUPPORT` → o modo janela falha antes do primeiro frame | `getContext … transferred its control to offscreen`; `SDL_emscriptenframebuffer.c:82` |
| WEB-2 | **B** | Renderer acelerado do SDL (GLES2/EGL) não funciona a partir do worker | `createShader` de `undefined`; `libegl.js:317` (`eglCreateContext__proxy: 'sync'`) |
| WEB-3 | **B** | Áudio SDL2 quebra no worker (bug do port) | `reading 'audioContext'`; `SDL_emscriptenaudio.c:273` usa `EM_ASM_INT` |
| WEB-4 | M | `host_window` cai para renderer por software sem logar a falha do acelerado quando vsync não foi pedido | `src/runtime/host_window.cpp:1150-1163` |
| WEB-5 | M | Self-heal se anuncia `ENABLED backend=tcc … linux-x64` no navegador (não há compilador); precisa de gate `__EMSCRIPTEN__` (sem worker, miss loud, cobertura honesta) | banner no console; `overlay_loader.cpp` (ver `WEB_WASM_EXPERIMENTS.md` §4.2) |
| WEB-6 | M | Entrada (teclado/gamepad) **não testada**: eventos nascem na thread principal e o SDL roda no worker | — |
| WEB-7 | M | Desempenho **não medido** no navegador (FPS real, custo do proxy síncrono por frame do renderer por software, interpretação dos misses) | — |
| WEB-8 | M | `.sav` fica em MEMFS e some ao recarregar a página (precisa IDBFS + `FS.syncfs`) | `WEB_WASM_PORT.md` §4 |
| WEB-9 | I | O runtime exige `[rom].sha1` no TOML de runtime; o `game.toml` do PK é do schema do recompilador. Contornado com `--rom-sha1` / `rom_sha1.js` | `WEB_WASM_EXPERIMENTS.md` §4.1 |
| PK-1 | I | PK **não é FULLY_STATIC**: 36 misses em 1.800 frames, 54 em 10.800, 29 em 600 (igual no nativo). Inclui código na IWRAM (`0x03001AA8`, `0x03002750`, `0x0300287C`, `0x03007Dxx`), funções não descobertas em `0x080AA4xx`, `0x0816Dxxx`–`0x0817Bxxx`, `0x082DF7E4`–`0x082E1628` e `0x08000000`. No navegador só sobrevive porque a ponte do interpretador funciona | banner `self_heal_coverage=NOT_STATIC`; `recomp_master_misses_BPEE.toml.frag` |
| PK-2 | I | Aborto pré-existente com input replay (~10.000 frames): `SELF-HEAL bridge for 0x080008C8 exceeded 200000000 instructions`. **Relatado pela sessão anterior; não foi reexecutado nesta** | `WEB_WASM_TAILCALL_IMPLEMENTATION.md` §9.2 |
| PK-3 | I | 10 entradas de controle de fluxo em jump table auto-detectada (`[0x0807BC1C,0x0807C04C)`) | topo de `output/pk/recompile.log` |
| BLD-1 | I | `symbol_map.cpp` some quando linkado a partir do archive (sem nomes no debugger) | `RECOMP_LOG_POKEMON_EMERALD.md` §5 |
| BLD-2 | I | Aviso `-pthread + ALLOW_MEMORY_GROWTH may run non-wasm code slowly` em todo link MT | saída do `em++` |
| BLD-3 | I | Mensagens `GPU stall due to ReadPixels` no Chrome headless com o bundle sem OffscreenCanvas; origem não investigada (provavelmente SwiftShader) | log do cenário `noocs-window` |

### Não validado nesta sessão

- Windows (V9 do plano: MinGW gcc + tcc empacotado).
- Comparação stdout nativo novo × nativo antigo (E16 do protótipo) — o A/B foi feito por texto e objeto.
- Chrome com GPU real, Firefox e Safari; 10.800 frames no navegador; áudio real; entrada; gameplay.
- `tests/selfheal/stage2_bios_identical.sh` (depende de MinishCapRecomp).

---

## 6. Próximos passos (em ordem recomendada)

1. **Tornar o modo janela funcional por padrão (WEB-1/2/3 — contorno já provado).**
   - `packaging/web/build_web.sh`: remover `-sOFFSCREENCANVAS_SUPPORT -sOFFSCREEN_FRAMEBUFFER`.
   - `src/runtime/host_window.cpp`, sob `#if defined(__EMSCRIPTEN__)`: forçar
     `SDL_HINT_RENDER_DRIVER="software"` e, por enquanto, driver de áudio `dummy` (com log explícito de
     que o áudio está desligado na web).
   - Logar a falha do renderer acelerado antes do fallback (WEB-4).
   - Critério: o cenário padrão da página abre, apresenta frames e não gera erro no console.
2. **Testar num Chrome de verdade (com GPU):** imagem na tela, FPS, teclado (WEB-6/7). Se o teclado não
   chegar ao worker, investigar como o SDL2 port registra callbacks de evento com pthreads.
3. **Gate `__EMSCRIPTEN__` do self-heal (WEB-5):** sem worker de compilação; miss logado, contado e
   reportado no banner; nunca silencioso (`PRINCIPLES.md` "Honest self-healing").
4. **Áudio web próprio (WEB-3):** backend de áudio sob `__EMSCRIPTEN__` com AudioWorklet lendo um ring
   buffer em `SharedArrayBuffer` preenchido pelo worker; início por gesto do usuário (botão Start).
   Evita depender do port SDL2 (corrigir o port no cache do emsdk não é sustentável).
5. **Se o renderer por software for lento (WEB-7):** apresentar o framebuffer sem o renderer do SDL:
   WebGL criado **na pthread** com `emscripten_webgl_create_context` sobre OffscreenCanvas
   (volta a precisar de `OFFSCREENCANVAS_SUPPORT` e canvas transferido) e upload de textura 240×160.
   A entrada e o áudio continuariam fora do SDL nesse caso — decidir junto com os passos 2 e 4.
6. **Cobertura do PK (PK-1):** loop do `CLAUDE.md` — revisar `recomp_seed_proposals.toml` /
   `recomp_master_misses_BPEE.toml.frag`, merge manual no `output/pk/game.toml`, regerar, repetir até
   FULLY_STATIC. Código executado da IWRAM precisa de decisão própria (não se resolve só com
   `[[extra_func]]` na ROM). No navegador não há self-heal: é pré-requisito para um build web honesto.
7. **Saves persistentes (WEB-8):** IDBFS montado no `preRun`, `FS.syncfs` no flush do `.sav`.
8. **Empacotamento:** `[rom].sha1` no TOML de runtime (WEB-9), escolha de ROM por `<input type=file>`,
   pré-carregamento/compressão do `.wasm` (gzip/brotli), requisitos mínimos de navegador para tail calls
   (confirmar em webassembly.org/features).
9. **Pendências do plano:** V9 no Windows; publicar `a8802bb` do submódulo antes do push.

---

## 7. Como reproduzir tudo

Todos os comandos em **bash**, a partir da raiz do repo.

```bash
source ~/emsdk/emsdk_env.sh

# 1. nativo: recompilador, BIOS gerado, projeto do PK
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DGBARECOMP_COMPILER_CACHE=OFF
cmake --build build --target gba_recompile -- -j10
build/gba_recompile --bios bios/gba_bios.bin --config bios/gba_bios.toml --out build/generated_bios
GBARECOMP_CORE="$PWD/build/gba_recompile" python3 tools/cli.py build --rom roms/pk.gba \
  --output output/pk --config output/pk/game.toml --force

# 2. testes nativos (com o BIOS gerado)
cmake -S . -B build -DGBARECOMP_GENERATED_BIOS_DIR="$PWD/build/generated_bios"
cmake --build build -- -j10
(cd build && ctest -j10 && ./codegen_tests | tail -1)

# 3. bundle de navegador
bash packaging/web/build_web.sh output/pk build/generated_bios roms/pk.gba bios/gba_bios.bin
python3 packaging/web/serve.py output/pk/web 8080
#   http://127.0.0.1:8080/                                   (modo janela: hoje dá WEB-1)
#   http://127.0.0.1:8080/?args=--no-window%20--frames%201800&env=GBARECOMP_SELFHEAL_RECOMPILE=0

# 4. variante que funciona em janela (sem OffscreenCanvas): refazer só o link do passo 3 sem
#    -sOFFSCREENCANVAS_SUPPORT -sOFFSCREEN_FRAMEBUFFER, com saída em output/pk/web-noocs, e abrir
#   http://127.0.0.1:8080/?env=SDL_RENDER_DRIVER=software,SDL_AUDIODRIVER=dummy,GBARECOMP_SELFHEAL_RECOMPILE=0
```

Teste headless de navegador (padrão usado nesta sessão):

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
perl -e 'alarm shift; exec @ARGV' 120 "$CHROME" --headless=new --user-data-dir=/tmp/gbr-chrome \
  --no-first-run --use-angle=swiftshader --enable-unsafe-swiftshader \
  --autoplay-policy=no-user-gesture-required --enable-logging=stderr --v=0 --remote-debugging-port=0 \
  "http://127.0.0.1:8080/index.html?autostart=1" 2>&1 | grep CONSOLE
```

Scripts completos da sessão (T0, T8, V3/V4, V8, navegador) ficaram em
`/Volumes/SSD_1TB/www/fabio/gbarecomp-tailcall-work/*.sh`.

---

## 8. Artefatos no disco (nada disso está no git)

| Caminho | O que é | Pode apagar? |
|---|---|---|
| `build-base/` | build do código **antigo** (referência do A/B) | sim, depois de revisar a branch |
| `build/`, `build/generated_bios/` | build nativo novo + BIOS recompilado novo | não (usado pelos builds web) |
| `build-wasm-mt/`, `build-wasm-st/` | runtime wasm | não, se for continuar a web |
| `output/pk/` | projeto do PK regerado + libs nativa/wasm + `web/` | não |
| `output/pk/web-noocs/` | bundle experimental sem OffscreenCanvas | sim, depois do passo 6.1 |
| `/Volumes/SSD_1TB/www/fabio/gbarecomp-tailcall-work/` | baseline antigo (BIOS/PK gerados, `pk_native_old`), runs, logs, tcc, scripts, perfis do Chrome | sim (vários GB) — guardar os `.sh` se quiser reusar |
