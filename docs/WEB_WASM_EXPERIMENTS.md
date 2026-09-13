# WEB_WASM_EXPERIMENTS — diário do primeiro build WebAssembly

**Data:** 2026-09-13
**Alvo:** `output/pk` (Pokémon Emerald USA, BPEE, SHA-1 `f3ae0881…07b7`)
**Status:** runtime + jogo **compilam, linkam e rodam** em wasm (node). O estouro de
pilha (§4.3) foi **corrigido** pelas tail calls garantidas
(`docs/WEB_WASM_TAILCALL_IMPLEMENTATION.md`, branch `feat/web-wasm-tailcall`). Primeiro
teste em navegador: §11.

Complementa `docs/WEB_WASM_PORT.md` (o levantamento teórico). Este documento é
o que aconteceu na prática. Nenhum arquivo versionado foi alterado durante os
experimentos.

---

## TL;DR — o que levar daqui

1. **Compilar não é o problema.** Runtime, BIOS recompilado e as 99.274 funções
   do jogo compilam para wasm com **0 erros**. Sockets, `dlopen` e
   `std::system` compilam sob a emulação POSIX do Emscripten — as falhas que o
   `WEB_WASM_PORT.md` previa como erro de compilação só aparecem **em tempo de
   execução**.
2. **Link fecha com 0 símbolos indefinidos**, desde que o runtime inteiro entre
   no link.
3. **Threads são obrigatórias:** sem `-pthread` o runtime aborta em
   `overlay_loader_init`. Com `-pthread -sPROXY_TO_PTHREAD` funciona.
4. **O bloqueio real é a pilha.** O código gerado depende de o compilador
   transformar chamadas em posição de cauda em saltos. O clang faz isso no
   nativo (arm64), mas **não no wasm**, porque toda função gerada tem vários
   `return` (`if (runtime_should_yield()) return;` a cada instrução).
   `-mtail-call` sozinho **não resolve**. Mais stack **não resolve** (a
   profundidade cresce com o tempo).
5. Correção **implementada**: macros `GBARECOMP_TAIL_*` emitidas pelo recompilador,
   `musttail` só sob `__EMSCRIPTEN__`, nativo token-idêntico (seção 6 e
   `WEB_WASM_TAILCALL_IMPLEMENTATION.md`).

---

## 1. Ambiente

| Item | Valor |
|---|---|
| Host | macOS (Darwin 25.6), Apple Silicon, 10 núcleos, 16 GB |
| Emscripten | 6.0.9 em `~/emsdk` (ativar com `source ~/emsdk/emsdk_env.sh`) |
| Node (do emsdk) | 24.x |
| Recompilador nativo | `build/gba_recompile` (build nativo já existente) |

O shell da ferramenta é **zsh** — ver armadilha 8.3.

---

## 2. Fase 1 — código gerado do jogo sozinho

### Compilação

```sh
cd output/pk
source ~/emsdk/emsdk_env.sh
emcmake cmake -S . -B build-wasm -DCMAKE_BUILD_TYPE=Release
cmake --build build-wasm --parallel 6
```

- 64 shards + `dispatch_table.cpp` + `symbol_map.cpp`: **0 erros, 0 warnings**,
  45 s.
- `libgbarecomp_game.a`: 154 MB em wasm (133 MB nativo).
- O código gerado não usa intrinsics, `setjmp`, `thread_local` nem atributos
  dependentes de plataforma.

### Link de sondagem (só o jogo)

Um `main` que referencia `kDispatchTable` puxa todos os shards do archive:

```cpp
#include <cstdint>
#include <cstdio>
struct DispatchEntry { uint32_t addr; uint8_t thumb; uint8_t resume; void (*fn)(void); };
extern "C" const DispatchEntry kDispatchTable[];
int main() { std::printf("%p\n", (void*)kDispatchTable[0].fn); return 0; }
```

Resultado: **32 símbolos indefinidos**, todos da superfície do runtime
(`g_cpu`, `bus_read_*/bus_write_*`, `arm_set_nz*`, `runtime_dispatch`,
`runtime_tick`, `runtime_swi`, `runtime_msr_cpsr`, …). Comparado com
`nm -u` do archive nativo: **mesma lista** → nada específico de wasm.

### Tamanho real

Com stubs triviais dos 32 símbolos e `-O2` + `--whole-archive`:

| | bytes |
|---|---|
| `.wasm` (99.274 funções) | 44.478.783 (~44,5 MB) |
| gzip -9 | 8.324.345 (~8,3 MB) |
| link completo em `-O0` (com runtime) | ~96 MB |

O medo de "centenas de MB" do `WEB_WASM_PORT.md` §6 **não se confirmou**.

---

## 3. Fase 2 — runtime em wasm

### 3.1 Configure e build das libs

```sh
cd <raiz do gbarecomp>
source ~/emsdk/emsdk_env.sh
emcmake cmake -S . -B build-wasm -DCMAKE_BUILD_TYPE=Release -DGBARECOMP_COMPILER_CACHE=OFF
cmake --build build-wasm --target gbarecomp_runtime -- -k -j8
```

- Configure passa. SDL2 **não é encontrado** → `host_window` vira stub
  (esconde erros reais; ver 3.2).
- 61 objetos, **0 erros**, só warnings inofensivos (variáveis não usadas,
  `-Wmismatched-tags` em `Bus`).
- Use `-k` para coletar todos os erros de uma vez.

### 3.2 Com SDL2 de verdade

```sh
embuilder build sdl2        # baixa e compila o port (uma vez; fica no cache do emsdk)
S=~/emsdk/upstream/emscripten/cache/sysroot
emcmake cmake -S . -B build-wasm-sdl -DCMAKE_BUILD_TYPE=Release \
  -DGBARECOMP_COMPILER_CACHE=OFF \
  -DSDL2_INCLUDE_DIR=$S/include/SDL2 \
  -DSDL2_LIBRARY=$S/lib/wasm32-emscripten/libSDL2.a
```

`host_window.cpp` compila contra SDL2 real: **0 erros**. No link final, use
`-sUSE_SDL=2`.

### 3.3 Com BIOS recompilado

Sem `bios_recompiled.cpp` o runtime usa só o placeholder. Gere numa pasta
**fora** de `src/` para não sobrescrever o `bios_dispatch_table.cpp` versionado:

```sh
./build/gba_recompile --bios bios/gba_bios.bin --config bios/gba_bios.toml \
  --out build-wasm-bios/generated_bios
cmake -S . -B build-wasm-sdl -DGBARECOMP_GENERATED_BIOS_DIR=$PWD/build-wasm-bios/generated_bios
cmake --build build-wasm-sdl --target gbarecomp_runtime -- -k -j8
```

770 funções de BIOS, compila para wasm com **0 erros**. O configure deve
imprimir `BIOS recompiled output present — linking`.

### 3.4 Host mínimo e link completo

`gbarecomp_add_runtime_target` só lista o C gerado; o `main` vem do jogo e
chama `gbarecomp::run_game` (`src/runtime/runtime.h:232`). Host de teste:

```cpp
#include "runtime.h"
int main(int argc, char** argv) { return gbarecomp::run_game(argc, argv); }
```

Link (variante node, single-thread):

```sh
R=<raiz gbarecomp>; B=$R/build-wasm-sdl
em++ -O0 -std=c++20 \
  -I$R/src/runtime -I$R/src/armv4t -I$R/src/gba -I$R/src/debug \
  -I$R/external/arm-recomp-core/profiles/armv4t_gba \
  main.cpp \
  -Wl,--start-group \
    $B/libgbarecomp_runtime.a $B/libgbarecomp_debug.a $B/libgbarecomp_gba.a \
    $B/libgbarecomp_armv4t.a $B/libgbarecomp_recompile_core.a \
    $B/libgbarecomp_heal_gate.a $R/output/pk/build-wasm/libgbarecomp_game.a \
  -Wl,--end-group \
  -sUSE_SDL=2 -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=16777216 \
  -sNODERAWFS=1 -sEXIT_RUNTIME=1 --emit-symbol-map \
  -o pk_node.js
```

- **0 símbolos indefinidos.**
- Confirmado pelo `pk_node.js.symbols`: 99.274 símbolos `gf_*` (= total de
  `recompiled.h`) e o BIOS recompilado estão dentro do binário.
- `-sNODERAWFS=1` dá acesso direto ao sistema de arquivos no node;
  `--emit-symbol-map` é **essencial** para ler stack traces (ver 8.5).

### 3.5 Rodando no node

```sh
node pk_node.js --rom pk.gba --bios gba_bios.bin \
  --rom-sha1 f3ae088181bf583e55daf962a92bb46f4f1d07b7 --no-window --frames 120
```

Rode numa pasta descartável: o runtime cria `recomp_cache/` no diretório
atual e grava `.sav` ao lado da ROM.

---

## 4. Erros encontrados em tempo de execução (em ordem)

### 4.1 `missing expected ROM SHA-1; refusing to launch`

O `output/pk/game.toml` é o schema do **recompilador** (`[identity].sha1`). O
runtime exige `[rom].sha1`. Comportamento correto (recusa honesta).
**Contorno:** `--rom-sha1 <hash>`. Para um host de verdade, o TOML do runtime
precisa de `[rom].sha1`.

### 4.2 `system_error … "thread constructor failed"` → abort

Stack trace (via symbol map): `main → run_game → overlay_loader_init →
std::thread` (`src/runtime/overlay_loader.cpp:473`, chamado de
`src/runtime/runtime.cpp:1826`).

Threads do runtime:

| Onde | Quando é criada |
|---|---|
| `overlay_loader.cpp:473` (worker de self-heal) | sempre que self-heal está ligado (padrão) |
| `runtime.cpp:2134` (`game_thread`) | só com `--tcp` |
| `runtime_bus_bridge.cpp:212` (sampler) | só com `GBARECOMP_SAMPLE` |

- **Contorno para diagnóstico:** `GBARECOMP_SELFHEAL_RECOMPILE=0` (banner
  explícito, sem thread).
- **Correção real:** `-pthread` na compilação de **tudo** (runtime **e** lib do
  jogo) e no link, mais `-sPROXY_TO_PTHREAD`:

  ```sh
  emcmake cmake ... -B build-wasm-mt -DCMAKE_C_FLAGS=-pthread -DCMAKE_CXX_FLAGS=-pthread ...
  emcmake cmake -S output/pk -B output/pk/build-wasm-mt -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-pthread
  em++ -pthread ... -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=4 \
       -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=16777216 \
       -sDEFAULT_PTHREAD_STACK_SIZE=16777216 ...
  ```

- Primeiro link multithread falhou com
  `wasm-ld: error: initial memory too small, 18906336 bytes needed` — com
  pthreads a stack de 16 MB precisa caber na memória inicial (padrão 16 MB).
  **`-sINITIAL_MEMORY=67108864`** resolve.
- Resultado: worker de self-heal inicia, 120 frames rodam, `FULLY_STATIC`.
- Aviso esperado: `-pthread + ALLOW_MEMORY_GROWTH may run non-wasm code slowly`.

**Observação:** no wasm o self-heal se anuncia como `backend=gcc` e arch
`linux-x64` (o `#else` de `overlay_arch_abi()` em `overlay_loader.cpp:61`).
Enganoso — não existe compilador no navegador. Precisa de gate
`__EMSCRIPTEN__` antes de qualquer miss real acontecer.

### 4.3 `RangeError: Maximum call stack size exceeded` — **RESOLVIDO** (ver §6)

Não é a stack de memória linear (`-sSTACK_SIZE`); é a **pilha nativa do V8**.
Stack trace repetitivo:
`runtime_dispatch → _00000C04 → bios_resume_0C0C → runtime_dispatch → …`

Medições (headless, `GBARECOMP_SELFHEAL_RECOMPILE=0`):

| Binário | Stack V8 | Frames | Resultado |
|---|---|---|---|
| single-thread | padrão | 120 | ❌ estoura |
| single-thread | `--stack-size=2000` | 120 | ❌ |
| single-thread | `--stack-size=4000` | 120 | ✅ `FULLY_STATIC` |
| single-thread | `--stack-size=4000` | 600 | ❌ |
| single-thread | `--stack-size=7800` | 120 | ✅ |
| single-thread | `--stack-size=7800` | 1800 | ❌ |
| single-thread | padrão + `--no-liftoff` | 120 | ❌ |
| single-thread | `GBARECOMP_PRESENT_IN_PLACE=0` | 120 | ❌ |
| `PROXY_TO_PTHREAD` (Worker) | padrão | 120 | ✅ |
| `PROXY_TO_PTHREAD` (Worker) | padrão | 1800 | ❌ |
| `-mtail-call` | padrão | 600 / 1800 | ❌ / ❌ |

**Conclusão: a profundidade cresce com o tempo de jogo.** Nenhum tamanho de
stack salva, e no navegador não dá para mudar a stack do V8 de qualquer forma.
(Precaução, não testada: `--stack-size` acima do limite real da thread do SO
pode derrubar o node com segfault; por isso o valor máximo usado foi 7800 KB,
abaixo dos 8 MB da main thread do macOS.)

---

## 5. Causa raiz do 4.3

### 5.1 O padrão do código gerado

Desvio do guest vira chamada C em posição de cauda
(`build-wasm-bios/generated_bios/bios_recompiled.cpp`):

```c
/* 00000C0C  blt 0x00000c04 */
g_cpu.R[15] = 0x00000C0Cu;
if (runtime_should_yield()) return;
if (arm_cond_passes(0xbu)) {
    g_cpu.R[15] = 0x00000C04u;
    _00000C04();
    return;
}
...
/* fall-through */
runtime_dispatch(0x00000C0Cu);
return;
```

E `runtime_dispatch` (`src/armv4t/runtime_arm.cpp:819`) termina com
`entry->fn(); return;` — outra chamada de cauda. Um loop do guest vira
recursão do host, a menos que o compilador converta essas chamadas em saltos.

### 5.2 No nativo a conversão acontece

`objdump -dr` do shard 000 nativo (arm64), contando relocações `BRANCH26`:

| Destino | `b` (salto) | `bl` (chamada) |
|---|---|---|
| `_gf_*` | **842** | **0** |
| `_runtime_dispatch` | 1065 | 732 |

**O runtime nativo depende silenciosamente da otimização de sibling call do
clang.** As 732 chamadas `bl` para `runtime_dispatch` são, em princípio, as
chamadas guest `BL` legítimas (não-cauda); se a reserva de 16 MB também cobre
casos de cauda não convertidos no nativo **não foi verificado**.

### 5.3 No wasm a conversão não acontece — nem com `-mtail-call`

- `flags.make` confirma `-mtail-call -O3 -DNDEBUG` → a flag chegou ao compilador.
- Shard 000: `call=54661 return_call=0` sem a flag; `call=54652 return_call=9`
  com a flag. **Só 9 conversões.**
- Função única (`gf_tfunc_0800052A`) compilada à mão com `-O3 -mtail-call`:
  0 `return_call` → **o problema está no código, não no build.**
- Nenhuma das 1559 funções do shard usa a shadow stack (hipótese descartada).

### 5.4 Bissecção (Emscripten 6.0.9, `-O3 -mtail-call`)

| Variante | Resultado |
|---|---|
| `g_cpu.R[15]=…; runtime_dispatch(1u); return;` | ✅ `return_call` |
| `g_cpu.R[15]=…; gf_target(); return;` | ✅ |
| com chamada indireta `g_runtime_fn_entry_hook` antes | ✅ |
| com `runtime_tick(local)` antes | ✅ |
| com `if (g_runtime_insn_trace) runtime_insn_fp();` antes | ✅ |
| **com `if (runtime_should_yield()) return;` antes** | ❌ `call` |
| **com `return` antecipado dentro de `if`** (padrão `runtime_call_cancel_return`) | ❌ `call` |

**Qualquer função com mais de um `return` perde a tail call no wasm.** Como o
codegen emite `if (runtime_should_yield()) return;` antes de **cada** instrução,
isso vale para praticamente todas as funções geradas.

O mecanismo exato dentro do LLVM (provavelmente a fusão dos blocos de `return`,
que o backend arm64 desfaz e o de WebAssembly não) **não foi verificado** — o
resultado empírico foi.

### 5.5 `[[clang::musttail]]`

| Teste | Resultado |
|---|---|
| `musttail` para `gf_target()` (`void(void)` → `void(void)`), função com vários `return` | ✅ `return_call` |
| `musttail` para `runtime_dispatch(1u)` (`void(void)` → `void(uint32_t)`) | ❌ erro: *"target function has different number of parameters (expected 0 but has 1)"* |
| `[[clang::musttail]]` **sem** `-mtail-call` | ignorado: *"unknown attribute 'clang::musttail' ignored"* |

---

## 6. Correção proposta (**implementada** — forma final em `WEB_WASM_TAILCALL_IMPLEMENTATION.md`)

A forma final difere do rascunho abaixo: macros `GBARECOMP_TAIL_*` com expansão nativa
token-idêntica ao texto antigo, `__attribute__((musttail))` em vez de `[[clang::musttail]]`,
e `#error` quando falta `-mtail-call`. Resultados medidos no repo real (protótipo: E11–E17):

| Verificação | Resultado |
|---|---|
| node, `PROXY_TO_PTHREAD` e single-thread, 1.800 e 10.800 frames | ✅ sem `RangeError` |
| node single-thread, 10.800 frames, `--stack-size=128` | ✅ |
| paridade wasm × nativo antigo (assinatura + `recomp_master_misses_BPEE.toml.frag`) | idêntica (36 misses em 1.800; 54 em 10.800) |
| `return_call` runtime / BIOS / shard 000 | 3 / 1.204 / 2.138 (antes: 0 no shard) |
| `.wasm` (`-O2`, MT) | 78.024.717 bytes |

Rascunho original:

Pelo `CLAUDE.md`, a correção entra no recompilador e no runtime — **nunca** em
`generated/`.

1. Macro no header do ABI (`runtime_arm.h`):

   ```c
   #if defined(__EMSCRIPTEN__)
   #  define GBARECOMP_TAIL [[clang::musttail]]
   #else
   #  define GBARECOMP_TAIL
   #endif
   ```

   Vazia no nativo → comportamento nativo inalterado.
2. `src/recompile/emit_function.cpp`: desvios diretos passam a ser emitidos como
   `GBARECOMP_TAIL return gf_x();`.
3. Dispatch: `musttail` exige assinatura idêntica, então criar uma variante
   `void(void)` (destino numa global, ex. `g_runtime_dispatch_target`) e emitir
   `GBARECOMP_TAIL return runtime_dispatch_tail();`.
4. Dentro do dispatch: `GBARECOMP_TAIL return entry->fn();` (e o mesmo em
   `runtime_dispatch_with_exchange`).
5. Chamadas guest `BL` (padrão `runtime_call_push_return` → `runtime_dispatch` →
   checagem) **não** são cauda por natureza; a profundidade delas é limitada
   pela profundidade de chamadas do guest, e não precisam mudar.

Validação necessária: regenerar BIOS e `pk`, confirmar contagem de
`return_call` no objeto, rodar ≥ 1800 frames em node com stack padrão, e
garantir que o build nativo continua byte-idêntico no comportamento
(`bios_intro_flawless` e demais ctests).

Alternativa mais invasiva (não recomendada agora): trampolim — funções geradas
retornam o próximo alvo em vez de chamá-lo.

---

## 7. Correções ao `WEB_WASM_PORT.md`

| O documento dizia | Na prática |
|---|---|
| Sockets (`tcp_debug_server`, `cosim`) precisam de stub para compilar | Compilam sob a emulação POSIX do Emscripten |
| `overlay_compile.cpp` precisa de gate para compilar | Compila; o problema é em execução (thread do worker, `backend=gcc` sem sentido) |
| Risco nº 1: tamanho do `.wasm` | ~44,5 MB (`-O2`), ~8,3 MB gzip — aceitável |
| `PROXY_TO_PTHREAD` preserva a arquitetura | Correto para threads, mas **não resolve** a pilha: o Worker também estoura |
| `-sSTACK_SIZE=16777216` é o ponto crítico da stack | Necessário, mas o limite que estoura é a pilha **do V8**, não a memória linear |
| Não mencionava | **Tail calls** são pré-requisito (seção 5), garantidas por `GBARECOMP_TAIL_*` + `-mtail-call` (compile **e** link) |

---

## 8. Armadilhas — não caia de novo

1. **`-sERROR_ON_UNDEFINED_SYMBOLS=0` não funciona para variáveis globais.**
   O wasm só importa funções; `g_cpu` indefinido continua erro. Para medir
   tamanho sem runtime, escreva stubs.
2. **`symbol_map.cpp` some sem aviso quando vem de um archive.** Ele se registra
   por inicializador estático e ninguém o referencia → o linker descarta. Só
   aparece com `--whole-archive`. Resultado: debugger sem nomes, sem erro. Vale
   também para o nativo se ele linkar o `.a`.
3. **zsh não faz word-splitting.** `for fl in "-O2 -mtail-call"; do em++ $fl …`
   passa um argumento único → `em++: error: invalid integral value '2 -mtail-call'`.
   Use `${=fl}`. E apague o `.o` antes de cada variação, senão o objdump lê
   um objeto velho e o teste parece válido.
4. **`[[clang::musttail]]` é C++;** em C use `__attribute__((musttail))`. E sem
   `-mtail-call` o Emscripten ignora o atributo com só um warning.
5. **Leia stack traces wasm com `--emit-symbol-map`.** O trace mostra
   `wasm-function[N]`; o arquivo `.symbols` mapeia `N:nome`.
6. **Um link wasm "rápido demais" com EXIT=0 merece verificação.** Confira tamanho
   do `.wasm` e o symbol map antes de acreditar.
7. **Configure sem SDL não reclama:** só imprime `SDL2 NOT found — host_window will
   stub out`. Um build "limpo" nesse estado não testou a janela.
8. **`gba_recompile --bios` sem `--out` sobrescreve `src/runtime/generated_bios/`**,
   inclusive o `bios_dispatch_table.cpp` versionado. Use `--out` numa pasta de build.
9. **Compile tudo com `-pthread`**, inclusive a lib do jogo. Aqui todos os
   objetos foram recompilados com a flag; misturar objetos com e sem `-pthread`
   **não foi testado**.
10. **Mais stack não é solução** quando a profundidade cresce com o tempo; meça
    em frames diferentes (120 / 600 / 1800) antes de concluir qualquer coisa.
11. **Rode experimentos em pasta descartável:** o runtime grava `recomp_cache/` no
    diretório atual e `.sav` ao lado da ROM.
12. **Nunca use `--bios-hle` para "fazer passar"** — proibido como caminho de
    correção pelo `CLAUDE.md`.

---

## 9. Onde ficaram os artefatos

| Caminho | Conteúdo | Git |
|---|---|---|
| `build-wasm/` | runtime wasm sem SDL | ignorado (`build-*/`) |
| `build-wasm-sdl/` | runtime wasm com SDL + BIOS recompilado | ignorado |
| `build-wasm-mt/` | runtime wasm `-pthread` | ignorado |
| `build-wasm-tc/` | runtime wasm `-mtail-call` | ignorado |
| `build-wasm-bios/generated_bios/` | BIOS recompilado + logs dos builds | ignorado |
| `output/pk/build-wasm{,-mt,-tc}/` | lib do jogo em wasm (normal / pthread / tail-call) | fora do git |
| `build-wasm-configure.log` (raiz) | log do primeiro configure | **não ignorado** — pode apagar |

Os binários de teste (`pk_node.js`, `pk_mt.js`, `pk_tc.js`), os stubs, o
`main.cpp` do host e os testes de tail call ficaram no scratchpad temporário da
sessão e **não persistem** — os trechos essenciais estão reproduzidos acima.

---

## 10. Próximos passos

1. Implementar a seção 6 (tail calls garantidas no codegen + dispatch) e validar.
2. Gate `__EMSCRIPTEN__` para o self-heal (sem worker, sem `backend=gcc`; miss
   deve ser loud, logado e reportado — nunca silencioso).
3. `[rom].sha1` no TOML de runtime do host web.
4. Só depois: `index.html`, headers COOP/COEP, gesto do usuário para áudio,
   IDBFS para `.sav`, pré-carregamento de ROM/BIOS.

---

## 11. Primeiro teste em navegador (depois das tail calls)

**Data:** 2026-09-13 · branch `feat/web-wasm-tailcall` · Chrome headless (macOS, WebGL via
SwiftShader) · bundle de `packaging/web/build_web.sh`.

### 11.1 Como montar e abrir

```bash
# 1. nativo: recompilador + BIOS gerado + projeto do jogo
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --target gba_recompile
build/gba_recompile --bios bios/gba_bios.bin --config bios/gba_bios.toml --out build/generated_bios
GBARECOMP_CORE=$PWD/build/gba_recompile python3 tools/cli.py build --rom roms/pk.gba \
  --output output/pk --config output/pk/game.toml --force
# 2. wasm: runtime + lib do jogo + link (PROXY_TO_PTHREAD, OFFSCREENCANVAS_SUPPORT)
bash packaging/web/build_web.sh output/pk build/generated_bios roms/pk.gba bios/gba_bios.bin
# 3. servir com COOP/COEP e abrir http://127.0.0.1:8080/
python3 packaging/web/serve.py output/pk/web 8080
```

A página aceita `?args=` (argumentos extras do runtime), `&env=K=V,K2=V2`, `&rom=`, `&bios=`,
`&sha1=` e `&autostart=1` (sem clique, para testes automatizados). Todo o log do runtime vai para
a página **e** para o `console`.

Bundle: `game.wasm` 80.309.833 bytes (`--profiling-funcs`, nomes de função no stack trace),
`game.js` 236.621 bytes, `game.js.symbols`.

### 11.2 Resultado: headless (`?args=--no-window --frames 1800&env=GBARECOMP_SELFHEAL_RECOMPILE=0`)

✅ **Roda até o fim no navegador**, `[exit] code=0`, sem `RangeError`. Paridade com o nativo
antigo (`pk_native_old`, mesmo cenário):

| Campo | Chrome | nativo |
|---|---|---|
| `final_pc` / `steps` | `0x080008ca` / 4160 | igual |
| `pal/vram/oam_nonzero` | 975 / 26066 / 600 | igual |
| `dispatch_misses` / `interpreted_insns` | 36 / 38.016.147 | igual |
| lista `bridged 0x… (modo) xN` | 36 PCs | **idêntica** (inclusive contagens) |

Ou seja: com a pilha resolvida, o núcleo (BIOS recompilado → jogo → interpretador de ponte)
se comporta no navegador exatamente como no nativo.

### 11.3 Erros atuais (a resolver, em ordem de bloqueio)

#### E-WEB-1 — janela: `getContext` num canvas transferido — **BLOQUEIO do modo janela**

Modo padrão (sem `--no-window`), console:

```
self_heal_recompile=ENABLED backend=tcc cache="recomp_cache/f3ae…/tcc/linux-x64/abi5-ram3" warm_loaded=0
Uncaught (in promise) InvalidStateError: Failed to execute 'getContext' on 'HTMLCanvasElement':
  Cannot get context from a canvas that has transferred its control to offscreen.
```

- **Onde:** `Browser.createContext` do glue JS do Emscripten (`canvas.getContext(...)` na
  **thread principal**) — o caminho que o port SDL2 usa para criar o contexto GL/EGL de
  `SDL_CreateRenderer` (`src/runtime/host_window.cpp:1150`).
- **Por quê:** com `-sOFFSCREENCANVAS_SUPPORT` + `PROXY_TO_PTHREAD`, o `#canvas` é transferido
  para o worker do `main()` no início; o port SDL2 continua criando o contexto pelo lado da
  thread principal, onde o canvas já não pode ser usado.
- **Nada aparece na tela**; o jogo não chega a mostrar o primeiro frame.
- **Atualização:** as direções abaixo foram testadas depois; resultado e bugs atuais em
  `docs/WEB_WASM_SESSION_2026-09-13.md` §3.2 e §5 (sem OffscreenCanvas + renderer por software +
  áudio `dummy` funciona; GL do SDL e áudio do SDL quebram no worker).
- **Direções a avaliar (texto original):**
  1. link **sem** `OFFSCREENCANVAS_SUPPORT` (canvas fica na thread principal) e ver se o SDL2
     faz proxy das chamadas GL/2D — risco: latência de proxy por frame;
  2. no host web, apresentar o framebuffer sem o renderer do SDL: contexto WebGL criado **na
     pthread** com `emscripten_webgl_create_context` sobre o OffscreenCanvas (a doc do
     Emscripten exige `OFFSCREENCANVAS_SUPPORT` + canvas transferido, que já temos) e upload de
     textura 240×160;
  3. renderer por software do SDL (`SDL_RENDERER_SOFTWARE`) — também usa `putImageData` no
     canvas da thread principal, então provavelmente cai no mesmo erro.

#### E-WEB-2 — self-heal se anuncia como `backend=tcc … linux-x64` no navegador

Já previsto em §4.2/§10.2. Sem `GBARECOMP_SELFHEAL_RECOMPILE=0` o worker de self-heal sobe e
anuncia um compilador que não existe no navegador. Precisa de gate `__EMSCRIPTEN__`: sem worker,
miss **loud** e reportado (nunca silencioso), cobertura honesta no banner.

#### E-WEB-3 — `pk` não é FULLY_STATIC (pré-existente, não é da web)

36 misses em 1.800 frames (54 em 10.800), idênticos ao nativo. Inclui código executado da IWRAM
(`0x03001AA8`, `0x03002750`, `0x0300287C`, `0x03007Dxx`). No navegador a sessão só sobrevive
porque a ponte do interpretador funciona; não há self-heal. Continua valendo
`WEB_WASM_PORT.md` §3 e o loop de cobertura do `CLAUDE.md`.

#### Ainda não exercitado no navegador

Áudio (AudioWorklet/gesto), entrada (teclado/gamepad a partir do worker), pacing do
`FramePacer` num worker, `.sav` persistente (IDBFS), 10.800 frames no navegador, Firefox e Safari.
