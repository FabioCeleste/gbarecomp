# WEB_WASM_TAILCALL_IMPLEMENTATION — plano de execução (tail calls garantidas)

**Data:** 2026-09-13
**Status:** **implementado** na branch `feat/web-wasm-tailcall` (submódulo: branch homônima,
commit `a8802bb`). T0–T8 e V1–V8 executados no repo real; resultados e desvios na seção 12.
**Substitui como guia de execução:** `docs/WEB_WASM_TAILCALL_PLAN.md` (que era o plano de
investigação; as perguntas abertas dele estão respondidas na seção 3.5).
**Contexto:** `docs/WEB_WASM_EXPERIMENTS.md` §4.3 e §5, `docs/WEB_WASM_PORT.md`,
`docs/RECOMP_LOG_POKEMON_EMERALD.md`.

Este documento é **autocontido**: todo o código (em forma de diff unificado), todos os
comandos e todos os scripts de validação estão aqui. Nenhum arquivo externo é necessário.

---

## 0. Resumo em 10 linhas

1. Todo desvio do guest que nunca volta ao chamador host (B, escrita em PC, BX, LDR/LDM/POP
   em PC, entrada de SWI, fall-through de função) é uma **chamada C em posição de cauda**.
2. No nativo o clang converte essas chamadas em saltos (medido: 100% dos sites). No wasm não
   converte → a pilha do V8 cresce com o tempo de jogo → `RangeError`.
3. O gerador passa a emitir esses sites como macros `GBARECOMP_TAIL_*(...)`.
4. **Nativo:** as macros expandem para **exatamente o texto de hoje** (`f(); return;`),
   token por token → objeto nativo idêntico, overlays gcc/tcc idênticos, **sem bump de ABI**.
5. **Emscripten:** expandem para `__attribute__((musttail)) return …` → `return_call`
   garantido pelo compilador (ou erro de compilação, nunca falha silenciosa).
6. `musttail` exige assinaturas iguais: os destinos `runtime_dispatch(uint32_t)`,
   `runtime_dispatch_with_exchange(uint32_t)` e `runtime_swi(uint32_t)` ganham variantes
   `void(void)` que leem o argumento de uma global `g_runtime_tail_arg`.
7. Sem `-mtail-call` o header dá `#error` (o em++ ignoraria o atributo em silêncio).
8. Protótipo: `pk` roda 10.800 frames em node (single-thread e `PROXY_TO_PTHREAD`), até com a
   pilha do V8 reduzida a 128 KB; o binário antigo estoura antes de 1.800 frames.
9. Paridade: o wasm novo produz **o mesmo estado final, os mesmos misses e as mesmas instruções
   interpretadas** que o nativo antigo em 1.800 e 10.800 frames.
10. A mudança atravessa o submódulo `external/arm-recomp-core` (commit lá + bump do ponteiro).

---

## 1. Causa raiz (resumo verificável)

### 1.1 O que o nativo faz hoje

`objdump -dr` de **todos** os shards nativos arm64 do `pk` (`output/pk/build/libgbarecomp_game.a`),
classificando cada relocação `BRANCH26` por instrução (`b` = salto de cauda, `bl` = chamada):

| Destino | `b` (cauda) | `bl` (chamada) | Leitura |
|---|---:|---:|---|
| `_gf_*` | 52.313 | 29 | os 29 `bl` são BL ARM com nome conhecido (não-cauda por natureza) |
| `_runtime_dispatch` | 66.694 | 46.667 | `bl` ≈ `bl _runtime_call_push_return` (46.696) → só BL/BLX |
| `_runtime_dispatch_with_exchange` | 12.460 | 0 | BX |
| `_runtime_swi` | 121 | 0 | SWI |
| `_runtime_call_cancel_return` | 46.223 | 0 | folha, não forma cadeia |
| `_runtime_tick` | 41 | 810.649 | folha, não forma cadeia |

E dentro de `runtime_dispatch` nativo a chamada `entry->fn()` termina em `br x0` (salto indireto).
**Conclusão:** o nativo depende de sibling-call em 100% dos sites de cauda. O wasm precisa
reproduzir exatamente esse conjunto: `gf_*`, `runtime_dispatch`, `runtime_dispatch_with_exchange`,
`runtime_swi` e o `entry->fn()` dentro do dispatch. Folhas (`cancel_return`, `tick`,
`exception_return`, `unimplemented_op`) não precisam.

### 1.2 O que o wasm faz hoje

- Shard 000 wasm atual: `return_call=0`, `call=54.661` (mesmo com `-mtail-call`: 9).
- Motivo (bissecção em `WEB_WASM_EXPERIMENTS.md` §5.4): função com mais de um `return` perde a
  tail call no backend WebAssembly. Todo corpo gerado tem `if (runtime_should_yield()) return;`
  por instrução.
- Trace real do estouro no binário antigo (mapeado pelo `.symbols`):
  `gf_tfunc_082E18B4 → runtime_dispatch → gf_tfunc_082E18B8 → runtime_dispatch → …`
  (loop do guest que atravessa duas funções via dispatch).

### 1.3 Por que o resto não cresce

- **SWI** desempilha tudo: o retorno do BIOS deixa R15 no PC pós-SWI e a cascata
  `if (R15 != link) { runtime_call_cancel_return(); return; }` volta até o loop externo.
- **BL/BLX** são chamadas reais; profundidade limitada pela profundidade de chamadas do guest
  (pilha de retorno de 1024 entradas, `present_in_place` força unwind por profundidade).
- **IRQ** (`runtime_irq`, chamado de dentro de `runtime_tick`) roda o handler num loop; limitado
  pela profundidade de aninhamento de IRQ.

---

## 2. Evidências do protótipo (o que foi provado)

Protótipo: cópia do código em diretório temporário, com exatamente os diffs da seção 5 aplicados.
Ambiente: macOS arm64, Apple clang 21.0.0, Emscripten **6.0.9**, Node **24.14.1**,
tcc **0.9.28rc** (mob@0fb5430, compilado do fonte), CMake Release.

| # | Verificação | Resultado |
|---|---|---|
| E1 | `codegen_tests` nativo com gerador novo | 131/131 ✅ |
| E2 | `ctest` nativo completo (29 testes) — protótipo e baseline | 29/29 e 29/29 ✅ |
| E3 | BIOS: texto novo com macros expandidas → comparado byte a byte com o gerador antigo | 4 arquivos, **0 diferenças**, 1.511 macros ✅ |
| E4 | `pk`: idem | 67 arquivos, **0 diferenças**, 168.341 macros ✅ |
| E5 | Objeto nativo `-O3 -DNDEBUG` do shard 000 do `pk`, antigo × novo | disassembly **idêntica** (266.975 linhas) ✅ |
| E6 | Overlay de self-heal (prelúdio real do `overlay_emit.cpp` + função real do BIOS + SWI sintético) compilado com **tcc como C** e **c++ `-x c++`** | compila nos dois; disassembly idêntica ao texto antigo nos dois; token stream do tcc idêntico ✅ |
| E7 | Wasm `-mtail-call`: `runtime_arm.cpp.o` | `return_call=3` (os 3 esperados) ✅ |
| E8 | Wasm: objeto do BIOS recompilado | `return_call=1.204` ✅ |
| E9 | Wasm: shard 000 do `pk` | `return_call` 0 → **2.138** ✅ |
| E10 | em++ sem `-mtail-call` em TU que inclui `runtime_arm.h` | `#error "gbarecomp: generated code needs guaranteed tail calls…"` ✅ |
| E11 | node, `PROXY_TO_PTHREAD`, stack padrão, 1.800 frames | antigo: `RangeError` ❌ · novo: ✅ |
| E12 | node, single-thread, stack padrão, 1.800 frames | antigo: `RangeError` ❌ · novo: ✅ |
| E13 | node, novo, 10.800 frames (MT e ST) | ✅ (MT 68 s, ST 43 s) |
| E14 | node, novo ST, 10.800 frames com `--stack-size=256` e `--stack-size=128` | ✅ ✅ (margem enorme) |
| E15 | Paridade wasm novo (MT e ST) × **nativo antigo**, 1.800 e 10.800 frames | `final_pc`, `steps`, `pal/vram/oam_nonzero`, `dispatch_misses` (36 / 54), `interpreted_insns` (38.016.147 / 269.727.239), lista de PCs e `recomp_master_misses_BPEE.toml.frag` **idênticos** ✅ |
| E16 | Nativo novo × nativo antigo, 1.800 frames | stdout inteiro idêntico ✅ |
| E17 | Tamanho `.wasm` (link `-O2`, MT) | 77.174.241 → 78.024.768 bytes (+1,1%); gzip 12,42 MB → 12,56 MB (+1,1%) |
| E18 | Replay de input com gameplay (START/A) 10.800 frames | nativo antigo, wasm MT e wasm ST abortam **igual** no mesmo ponto pré-existente (seção 9.2) — paridade mantida |

Não verificado (sem toolchain nesta máquina): MinGW gcc e MSVC. Risco considerado nulo porque a
expansão nativa é **token-idêntica** ao texto atual (E3/E4), mas a tarefa V9 manda repetir o
A/B no Windows se houver acesso.

---

## 3. Desenho final

### 3.1 Macros (em `src/armv4t/runtime_arm.h`)

| Macro emitida | Nativo (hoje, idêntico) | Emscripten |
|---|---|---|
| `GBARECOMP_TAIL_CALL(gf_x);` | `gf_x(); return;` | `__attribute__((musttail)) return gf_x();` |
| `GBARECOMP_TAIL_DISPATCH(pc);` | `runtime_dispatch(pc); return;` | `g_runtime_tail_arg = (pc); musttail return runtime_dispatch_tail();` |
| `GBARECOMP_TAIL_DISPATCH_WITH_EXCHANGE(pc);` | `runtime_dispatch_with_exchange(pc); return;` | `g_runtime_tail_arg = (pc); musttail return runtime_dispatch_with_exchange_tail();` |
| `GBARECOMP_TAIL_SWI(imm);` | `runtime_swi(imm); return;` | `g_runtime_tail_arg = (imm); musttail return runtime_swi_tail();` |

**Decisões e porquês:**

- **Sem `do { } while (0)`.** A expansão nativa é literalmente `call; return` (duas instruções).
  Isso torna o texto pré-processado nativo token-idêntico ao atual (E3–E6), inclusive em `-O0`
  (com `do/while` o `-O0` nativo muda — medido). O custo é uma regra de uso: a macro só pode
  aparecer como **instrução completa numa linha própria dentro de bloco com chaves**. O gerador
  já só emite assim, e a tarefa T7 adiciona uma asserção automática no `gen_codegen_tests`.
- **`__attribute__((musttail))` e não `[[clang::musttail]]`.** Funciona em C e C++ no clang
  (validado com `emcc` C11 e `em++` C++20), e o header é incluído por TUs dos dois tipos.
- **Global `g_runtime_tail_arg`** (opção A do plano anterior). É escrita imediatamente antes do
  `return_call` e lida como primeira coisa pelo destino; não há código entre as duas. A execução
  do guest é single-threaded (o worker de self-heal só compila), então não há corrida.
- **Variantes `void(void)` sempre compiladas** (também no nativo, onde ficam sem uso pelo código
  gerado). Mantém um único runtime e permite testá-las nativamente.
- **`runtime_dispatch(uint32_t)` continua existindo** e é usado por BL/BLX, pelo loop externo
  (`runtime.cpp` `step_once`), por `runtime_irq`, `test_rom_runner` e `ws_sidecar`. A lógica
  comum foi fatorada em `dispatch_resolve()`; o comportamento é idêntico (E2, E15, E16).

### 3.2 Por que **não** há bump de `GBA_OVERLAY_ABI_VERSION`

- `GbaOverlayCallbacks` não muda (nenhum membro novo).
- O overlay nativo usa só a expansão nativa, que chama as thunks existentes
  (`runtime_dispatch`, `runtime_dispatch_with_exchange`, `runtime_swi`).
- O código compilado do overlay é idêntico ao atual (E6), então DLLs em cache continuam válidos.

### 3.3 Onde as macros moram

- `src/armv4t/runtime_arm.h`: definição completa (nativo + Emscripten). É o header que todo
  código gerado inclui e que `tools/cli.py` já copia para `framework/include/`.
- `src/runtime/overlay_runtime_arm.h`: **só a expansão nativa**, perto das thunks. O shim é
  deliberadamente independente do `runtime_arm.h` (ver o comentário do próprio arquivo), e o
  `tools/fetch_tcc.ps1` já empacota esse arquivo → **nenhum header novo para empacotar**.
- Nada muda em `runtime_arm_types.h` (nas três cópias).

### 3.4 Sites de emissão (inventário final)

| Arquivo | Construção | Hoje | Depois |
|---|---|---|---|
| `arm_codegen.cpp` `emit_direct_branch` | B com nome conhecido | `gf_x();` + `return;` | `GBARECOMP_TAIL_CALL(gf_x);` |
| idem | B sem nome | `runtime_dispatch(0x…u);` + `return;` | `GBARECOMP_TAIL_DISPATCH(0x…u);` |
| idem | `b .` (self-loop) | `return;` | `return;` (inalterado) |
| idem | BL (ARM) | `gf_x();`/`runtime_dispatch(…);` + checagem | inalterado |
| `emit_data_processing` | escrita em PC (inclui `mov pc, lr` sem match) | `runtime_dispatch(_pc);` + `return;` | `GBARECOMP_TAIL_DISPATCH(_pc);` |
| idem | `movs pc, lr` (exception return) | `runtime_exception_return(r); return;` | inalterado (folha) |
| `emit_branch` BX | `runtime_dispatch_with_exchange(t);` + `return;` | | `GBARECOMP_TAIL_DISPATCH_WITH_EXCHANGE(t);` |
| `emit_branch` BL_suffix (THUMB BL) | `runtime_dispatch(t);` + checagem | | inalterado |
| `emit_memory` LDR em PC | `runtime_dispatch(_v & ~1u);` + `return;` | | `GBARECOMP_TAIL_DISPATCH(_v & ~1u);` |
| `emit_block_transfer` LDM lista vazia | `runtime_dispatch(g_cpu.R[15]);` + `return;` | | `GBARECOMP_TAIL_DISPATCH(g_cpu.R[15]);` |
| `emit_block_transfer` LDM/POP com PC | idem (base SP e não-SP) | | idem |
| `emit_swi` | `runtime_swi(imm);` + `return;` | | `GBARECOMP_TAIL_SWI(imm);` |
| `runtime_unimplemented_op(); return;` | | | inalterado (aborta) |
| `emit_function.cpp` fall-through | `runtime_dispatch(0x…u);` + `return;` | | `GBARECOMP_TAIL_DISPATCH(0x…u);` |
| `runtime_arm.cpp` `runtime_dispatch_tail` | — | | `GBARECOMP_TAIL_CALL(entry->fn);` |
| `runtime_arm.cpp` `runtime_dispatch_with_exchange_tail` | — | | `GBARECOMP_TAIL_DISPATCH(target_pc);` |
| `runtime_arm.cpp` `runtime_swi_tail` | — | | `GBARECOMP_TAIL_DISPATCH(0x00000008u);` |

Fora de escopo: `profiles/armv5te_nds` (outro modelo de execução).

### 3.5 Respostas às perguntas do plano anterior

1. *Trocar a forma literal por macro com função?* → Sim, e sem `do/while` (3.1).
2. *Opção A (global + `void(void)`)?* → Sim; não muda ABI do overlay (3.2).
3. *Onde a macro mora?* → `runtime_arm.h` + expansão nativa no shim (3.3). Não no
   `runtime_arm_types.h` do submódulo.
4. *Bump da ABI do overlay?* → Não é necessário (3.2).
5. *tcc aceita?* → Sim; o tcc só vê a forma nativa, que é o texto de hoje (E6).

---

## 4. Pré-requisitos

- Submódulo inicializado: `git submodule update --init external/arm-recomp-core`
  (commit atual `763b922f`).
- Emscripten **6.0.9** (`source ~/emsdk/emsdk_env.sh`) e o port SDL2 (`embuilder build sdl2`).
- ROM `roms/pk.gba` (SHA-1 `f3ae088181bf583e55daf962a92bb46f4f1d07b7`), BIOS `bios/gba_bios.bin`,
  config `output/pk/game.toml` (todos locais, não versionados).
- Python 3.9+. **Rodar os scripts em `bash`**, não em `zsh` (ver armadilha 10.1).
- Uma pasta de trabalho descartável fora do repo, daqui em diante chamada `$W`
  (ex.: `W=$(mktemp -d)`). Nada de validação deve escrever dentro do repo além de `build-*`.

---

## 5. Tarefas de implementação

Ordem obrigatória: **T0 → T1 … T8**. T0 precisa rodar **antes** de qualquer edição, pois
produz a referência do A/B.

### T0 — Congelar a referência (antes de editar qualquer coisa)

```bash
set -euo pipefail
R=/caminho/para/gbarecomp            # raiz do repo
W=$(mktemp -d); echo "W=$W"          # anote: todas as validações usam esta pasta
cd "$R"
git status --short                   # deve estar sem mudanças em src/, external/, tools/, cmake/, tests/
cmake -S . -B build-base -DCMAKE_BUILD_TYPE=Release -DGBARECOMP_COMPILER_CACHE=OFF
cmake --build build-base --target gba_recompile codegen_tests -- -j8
cp build-base/gba_recompile "$W/gba_recompile_base"
mkdir -p "$W/old/bios" "$W/old/pk"
"$W/gba_recompile_base" --bios bios/gba_bios.bin --config bios/gba_bios.toml --out "$W/old/bios"
"$W/gba_recompile_base" --rom roms/pk.gba --config output/pk/game.toml --out "$W/old/pk/generated"
(cd build-base && ctest -j8) | tail -3   # referência: 100% de 29
```

**T0.b — executável nativo de referência** (ainda com o código antigo; usado em V8):

```bash
set -euo pipefail
cd "$R"
cmake -S . -B build-base -DGBARECOMP_GENERATED_BIOS_DIR="$W/old/bios"   # runtime com BIOS recompilado antigo
cmake --build build-base --target gbarecomp_runtime gbarecomp_debug -- -j8
python3 - <<EOF
import sys; from pathlib import Path
sys.path.insert(0, "$R/tools"); import cli
out = Path("$W/old/pk"); cli.copy_framework(out); cli.write_project(out, Path("$R/roms/pk.gba"), True)
EOF
cmake -S "$W/old/pk" -B "$W/old/pk/build-native" -DCMAKE_BUILD_TYPE=Release
cmake --build "$W/old/pk/build-native" -- -j8
mkdir -p "$W/link"
printf '#include "runtime.h"\nint main(int argc, char** argv) { return gbarecomp::run_game(argc, argv); }\n' > "$W/link/main.cpp"
B="$R/build-base"
c++ -O2 -std=c++20 -I"$R/src/runtime" -I"$R/src/armv4t" -I"$R/src/gba" -I"$R/src/debug" \
  -I"$R/external/arm-recomp-core/profiles/armv4t_gba" "$W/link/main.cpp" \
  $B/libgbarecomp_runtime.a $B/libgbarecomp_debug.a $B/libgbarecomp_gba.a \
  $B/libgbarecomp_armv4t.a $B/libgbarecomp_recompile_core.a $B/libgbarecomp_heal_gate.a \
  $B/libgbarecomp_runtime.a $B/libgbarecomp_debug.a "$W/old/pk/build-native/libgbarecomp_game.a" \
  $(pkg-config --libs sdl2 2>/dev/null || echo /opt/homebrew/lib/libSDL2.dylib) -o "$W/link/pk_native_old"
```

(No macOS repetir `runtime`/`debug` no fim resolve a ordem dos archives. No Linux use
`-Wl,--start-group … -Wl,--end-group` e adicione `-pthread -ldl`.)

`build-base` fica com `GBARECOMP_GENERATED_BIOS_DIR` apontando para `$W/old/bios`; em T8/V1 isso
não interfere (o gerador e os testes não dependem do BIOS gerado).

> **Nunca** rode `gba_recompile --bios` sem `--out`: ele sobrescreve
> `src/runtime/generated_bios/` (inclusive o `bios_dispatch_table.cpp` versionado).

### T1 — Gerador: `external/arm-recomp-core/profiles/armv4t_gba/arm_codegen.cpp` (submódulo)

Aplicar exatamente:

```diff
--- a/external/arm-recomp-core/profiles/armv4t_gba/arm_codegen.cpp
+++ b/external/arm-recomp-core/profiles/armv4t_gba/arm_codegen.cpp
@@ -414,34 +414,38 @@
             function_key(target, ctx.current_function_thumb));
         if (it != ctx.names_by_key->end()) name = &it->second;
     }
-    if (name) {
-        if (!is_link && target == ctx.current_function_addr) {
-            // A tight `b .` loop must not become recursive host C.
-            // Return to the dispatch loop with PC unchanged so the
-            // runtime can observe/stall the guest loop normally.
-        } else {
-            s << indent << *name << "();\n";
-        }
-    } else {
-        if (!is_link && target == ctx.current_function_addr) {
-            // See known-name self-loop case above.
+    const bool self_loop = !is_link && target == ctx.current_function_addr;
+    if (self_loop) {
+        // A tight `b .` loop must not become recursive host C.
+        // Return to the dispatch loop with PC unchanged so the
+        // runtime can observe/stall the guest loop normally.
+        s << indent << "return;\n";
+        return s.str();
+    }
+    if (!is_link) {
+        // B never returns to this caller: a guaranteed tail transfer.
+        // The macro expands to exactly `<call>; return;` natively and to
+        // a musttail return under Emscripten (see runtime_arm.h).
+        if (name) {
+            s << indent << "GBARECOMP_TAIL_CALL(" << *name << ");\n";
         } else {
-            s << indent << "runtime_dispatch(" << fmt_hex32(target) << ");\n";
+            s << indent << "GBARECOMP_TAIL_DISPATCH(" << fmt_hex32(target)
+              << ");\n";
         }
+        return s.str();
     }
-    // B is a tail-call: never return to this caller, so emit
-    // `return;`. BL is a call: after the callee returns (its `bx lr`
-    // sets PC=LR, then C-returns), control must resume in this
-    // function's body at the next instruction. So DO NOT emit
-    // `return;` for BL — let C control fall through to the next
-    // decoded instruction.
-    if (is_link) {
-        s << indent << "if (g_cpu.R[15] != " << fmt_hex32(link_value & ~1u)
-          << ") { runtime_call_cancel_return("
-          << fmt_hex32(link_value & ~1u) << "); return; }\n";
-    } else {
-        s << indent << "return;\n";
+    // BL is a call: after the callee returns (its `bx lr` sets PC=LR,
+    // then C-returns), control must resume in this function's body at
+    // the next instruction. So DO NOT emit `return;` for BL — let C
+    // control fall through to the next decoded instruction.
+    if (name) {
+        s << indent << *name << "();\n";
+    } else {
+        s << indent << "runtime_dispatch(" << fmt_hex32(target) << ");\n";
     }
+    s << indent << "if (g_cpu.R[15] != " << fmt_hex32(link_value & ~1u)
+      << ") { runtime_call_cancel_return("
+      << fmt_hex32(link_value & ~1u) << "); return; }\n";
     return s.str();
 }
 
@@ -677,12 +681,8 @@
             if (is_lr_return) {
                 body << indent << "if (runtime_call_should_return("
                      << pc_var << ")) return;\n";
-                body << indent << "runtime_dispatch(" << pc_var << ");\n";
-                body << indent << "return;\n";
-            } else {
-                body << indent << "runtime_dispatch(" << pc_var << ");\n";
-                body << indent << "return;\n";
-            }
+            }
+            body << indent << "GBARECOMP_TAIL_DISPATCH(" << pc_var << ");\n";
         } else {
             body << indent << "g_cpu.R[" << static_cast<unsigned>(ins.rd)
                  << "] = " << r_var << ";\n";
@@ -730,14 +730,9 @@
                 // non-caller via BL/BLX from a different source)
                 // is handled by the dispatch path below.
                 body << indent << "if (runtime_call_should_return(g_cpu.R[15])) return;\n";
-                body << indent << "runtime_dispatch_with_exchange("
-                     << target_var << ");\n";
-                body << indent << "return;\n";
-            } else {
-                body << indent << "runtime_dispatch_with_exchange("
-                     << target_var << ");\n";
-                body << indent << "return;\n";
             }
+            body << indent << "GBARECOMP_TAIL_DISPATCH_WITH_EXCHANGE("
+                 << target_var << ");\n";
             return true;
         }
         case IrOp::BL_prefix:
@@ -871,8 +866,7 @@
         if (ins.rd == 15) {
             body << indent << "g_cpu.R[15] = " << val_var << " & ~1u;\n";
             body << indent << "runtime_tick(" << cyc_var_for(ins) << ");\n";
-            body << indent << "runtime_dispatch(" << val_var << " & ~1u);\n";
-            body << indent << "return;\n";
+            body << indent << "GBARECOMP_TAIL_DISPATCH(" << val_var << " & ~1u);\n";
         } else {
             body << indent << "g_cpu.R[" << static_cast<unsigned>(ins.rd)
                  << "] = " << val_var << ";\n";
@@ -961,8 +955,7 @@
             }
             body << indent << "g_cpu.R[15] = " << pcv << " & ~1u;\n";
             body << indent << "runtime_tick(" << cyc_var_for(ins) << ");\n";
-            body << indent << "runtime_dispatch(g_cpu.R[15]);\n";
-            body << indent << "return;\n";
+            body << indent << "GBARECOMP_TAIL_DISPATCH(g_cpu.R[15]);\n";
         } else {
             body << indent << "if (runtime_trace_enabled()) runtime_trace_event(RUNTIME_TRACE_MEM_WRITE, "
                  << fmt_hex32(ins.pc) << ", " << addr_var << " & ~3u, "
@@ -1081,12 +1074,8 @@
         body << indent << "runtime_tick(" << cyc_var_for(ins) << ");\n";
         if (blk.rn == 13) {
             body << indent << "if (runtime_call_should_return(g_cpu.R[15])) return;\n";
-            body << indent << "runtime_dispatch(g_cpu.R[15]);\n";
-            body << indent << "return;\n";
-        } else {
-            body << indent << "runtime_dispatch(g_cpu.R[15]);\n";
-            body << indent << "return;\n";
         }
+        body << indent << "GBARECOMP_TAIL_DISPATCH(g_cpu.R[15]);\n";
     }
     return true;
 }
@@ -1266,8 +1255,7 @@
               const char* indent) {
     body << indent << "g_cpu.R[15] = "
          << fmt_hex32(ins.pc + (ins.thumb ? 2u : 4u)) << ";\n";
-    body << indent << "runtime_swi(" << fmt_hex32(ins.swi_imm) << ");\n";
-    body << indent << "return;\n";
+    body << indent << "GBARECOMP_TAIL_SWI(" << fmt_hex32(ins.swi_imm) << ");\n";
     return true;
 }
 
```

Notas para quem implementa:
- O caso BL para a própria função (`is_link && target == current_function_addr`) continua
  emitindo a chamada — `self_loop` só vale para `!is_link`, como antes.
- O caso `bl` para a instrução seguinte (idioma get-PC) sai antes, na linha
  `if (is_link && target == link_value) return s.str();`, que não muda.

### T2 — Gerador: `src/recompile/emit_function.cpp`

```diff
--- a/src/recompile/emit_function.cpp
+++ b/src/recompile/emit_function.cpp
@@ -398,8 +398,7 @@
     appendf(out,
         "    /* fall-through to 0x%08X */\n"
         "    g_cpu.R[15] = 0x%08Xu;\n"
-        "    runtime_dispatch(0x%08Xu);\n"
-        "    return;\n",
+        "    GBARECOMP_TAIL_DISPATCH(0x%08Xu);\n",
         fn.end_addr, fn.end_addr, fn.end_addr);
 
     return out;
```

### T3 — ABI do código gerado: `src/armv4t/runtime_arm.h`

```diff
--- a/src/armv4t/runtime_arm.h
+++ b/src/armv4t/runtime_arm.h
@@ -161,6 +161,49 @@
 void runtime_dispatch_with_exchange(uint32_t target_pc);
 void runtime_dispatch_miss(uint32_t target_pc);
 
+// ── Guaranteed tail transfers ──────────────────────────────────────
+// Every guest transfer that never returns to its host caller (B, a computed
+// PC write, BX, LDR/LDM/POP into PC, SWI entry and the function fall-through)
+// is a C call in tail position. Native clang/gcc lower those calls to jumps
+// (sibling-call optimisation), so a guest loop that crosses function
+// boundaries costs no host stack. The WebAssembly backend does not: every
+// generated function has several `return`s and the calls stay calls, so the
+// V8 stack overflows as play time grows (docs/WEB_WASM_EXPERIMENTS.md §5).
+//
+// The generator emits those transfers through the macros below, always as a
+// complete statement at the start of a line inside a braced block (never as
+// the body of an unbraced `if`). Natively they expand to exactly the
+// historical text — `f(); return;` — so native builds, the gcc/tcc self-heal
+// overlays and MSVC see the same token stream as before. Under Emscripten
+// they become musttail returns, which clang must lower to `return_call` or
+// reject at compile time. musttail needs identical signatures, so the
+// dispatch-shaped transfers hand their argument over in g_runtime_tail_arg to
+// void(void) entry points. Set immediately before the tail call and read
+// first thing by the callee; nothing may run between.
+extern uint32_t g_runtime_tail_arg;
+void runtime_dispatch_tail(void);                // runtime_dispatch(g_runtime_tail_arg)
+void runtime_dispatch_with_exchange_tail(void);  // runtime_dispatch_with_exchange(g_runtime_tail_arg)
+void runtime_swi_tail(void);                     // runtime_swi(g_runtime_tail_arg)
+
+#if defined(__EMSCRIPTEN__)
+#  if !defined(__wasm_tail_call__)
+#    error "gbarecomp: generated code needs guaranteed tail calls; compile and link with -mtail-call"
+#  endif
+#  define GBARECOMP_MUSTTAIL __attribute__((musttail))
+#  define GBARECOMP_TAIL_CALL(fn) GBARECOMP_MUSTTAIL return fn()
+#  define GBARECOMP_TAIL_DISPATCH(pc) \
+       g_runtime_tail_arg = (pc); GBARECOMP_MUSTTAIL return runtime_dispatch_tail()
+#  define GBARECOMP_TAIL_DISPATCH_WITH_EXCHANGE(pc) \
+       g_runtime_tail_arg = (pc); GBARECOMP_MUSTTAIL return runtime_dispatch_with_exchange_tail()
+#  define GBARECOMP_TAIL_SWI(imm) \
+       g_runtime_tail_arg = (imm); GBARECOMP_MUSTTAIL return runtime_swi_tail()
+#else
+#  define GBARECOMP_TAIL_CALL(fn) fn(); return
+#  define GBARECOMP_TAIL_DISPATCH(pc) runtime_dispatch(pc); return
+#  define GBARECOMP_TAIL_DISPATCH_WITH_EXCHANGE(pc) runtime_dispatch_with_exchange(pc); return
+#  define GBARECOMP_TAIL_SWI(imm) runtime_swi(imm); return
+#endif
+
 // Whole-program force-interpreter backend (co-simulation "interp" side). When
 // g_force_interp != 0, the main run loop calls runtime_force_interp_step() once
 // per guest instruction instead of dispatching generated code — interpreting the
```

As declarações ficam dentro do `extern "C" { … }` já existente do header (a âncora está nele).

### T4 — Runtime: `src/armv4t/runtime_arm.cpp`

```diff
--- a/src/armv4t/runtime_arm.cpp
+++ b/src/armv4t/runtime_arm.cpp
@@ -816,7 +816,15 @@
 
 }  // namespace
 
-extern "C" void runtime_dispatch(uint32_t target_pc) {
+extern "C" uint32_t g_runtime_tail_arg = 0u;
+
+namespace {
+
+// Everything runtime_dispatch does before entering generated code. Returns the
+// entry to call, or nullptr when the transfer already completed here (force-
+// interpreter bridge, RAM hook, self-heal overlay or dispatch miss). Shared by
+// runtime_dispatch and runtime_dispatch_tail so the two stay identical.
+const DispatchEntry* dispatch_resolve(uint32_t target_pc) {
     // Strip THUMB bit; codegen handles the mode via cpsr_T already.
     uint32_t pc = target_pc & ~1u;
     if (runtime_trace_enabled())
@@ -830,12 +838,12 @@
     if (g_runtime_force_interp_hook &&
         g_runtime_force_interp_hook(pc, thumb ? 1 : 0)) {
         runtime_bridge_interpret(pc, thumb, 0u, 0u);
-        return;
+        return nullptr;
     }
     if (pc >= 0x02000000u && pc < 0x04000000u &&
         g_runtime_ram_dispatch_hook &&
         g_runtime_ram_dispatch_hook(pc, thumb ? 1 : 0)) {
-        return;
+        return nullptr;
     }
     const DispatchEntry* entry = nullptr;
     if (pc < kBiosRegionEnd) {
@@ -846,26 +854,53 @@
     }
     if (entry) {
         g_runtime_resume_pc = entry->resume ? pc : 0u;
-        entry->fn();
-        return;
+        return entry;
     }
     // Stage-2 self-heal: third dispatch tier. After the static tables miss,
     // consult the runtime-healed native overlays before bridging. Defined in
     // src/runtime/overlay_loader.cpp (a null stub in tests/codegen/stubs.cpp,
     // since armv4t must not depend on the runtime lib). When the feature is
     // off this is a single bool check and returns 0.
-    if (overlay_try_dispatch(pc, thumb ? 1 : 0)) return;
+    if (overlay_try_dispatch(pc, thumb ? 1 : 0)) return nullptr;
     runtime_dispatch_miss(target_pc);
+    return nullptr;
 }
 
-extern "C" void runtime_dispatch_with_exchange(uint32_t target_pc) {
+void exchange_instruction_set(uint32_t target_pc) {
     // Bit 0 of target indicates THUMB.
     if (target_pc & 1u) g_cpu.cpsr |= CPSR_T_BIT;
     else                g_cpu.cpsr &= ~CPSR_T_BIT;
     if (runtime_trace_enabled())
         runtime_trace_event(RUNTIME_TRACE_EXCHANGE, target_pc & ~1u, target_pc,
                             0, 0);
+}
+
+}  // namespace
+
+extern "C" void runtime_dispatch(uint32_t target_pc) {
+    const DispatchEntry* entry = dispatch_resolve(target_pc);
+    if (entry) entry->fn();
+}
+
+// Tail entry: the generated GBARECOMP_TAIL_DISPATCH stored the target in
+// g_runtime_tail_arg. Under Emscripten the call into generated code is a
+// guaranteed return_call, so a guest loop that crosses functions never grows
+// the host stack; natively it is the same sibling call runtime_dispatch makes.
+extern "C" void runtime_dispatch_tail(void) {
+    const DispatchEntry* entry = dispatch_resolve(g_runtime_tail_arg);
+    if (!entry) return;
+    GBARECOMP_TAIL_CALL(entry->fn);
+}
+
+extern "C" void runtime_dispatch_with_exchange(uint32_t target_pc) {
+    exchange_instruction_set(target_pc);
     runtime_dispatch(target_pc);
+}
+
+extern "C" void runtime_dispatch_with_exchange_tail(void) {
+    const uint32_t target_pc = g_runtime_tail_arg;
+    exchange_instruction_set(target_pc);
+    GBARECOMP_TAIL_DISPATCH(target_pc);
 }
 
 extern "C" int runtime_has_static_entry(uint32_t pc, int thumb) {
@@ -1170,7 +1205,11 @@
 // strong (production) version aborts there — that abort is the
 // "BIOS not recompiled" gate.
 
-extern "C" void runtime_swi(uint32_t swi_imm) {
+namespace {
+
+// SWI exception entry up to (not including) the BIOS vector dispatch. Returns
+// false when the opt-in HLE hook serviced the call and the guest resumes at LR.
+bool swi_enter(uint32_t swi_imm) {
     uint32_t return_address = g_cpu.R[15];
     uint32_t saved_cpsr     = g_cpu.cpsr;
     if (runtime_trace_enabled())
@@ -1192,7 +1231,7 @@
     if (g_bios_hle_hook) {
         bool thumb = (saved_cpsr & CPSR_T_BIT) != 0;
         uint32_t swi_num = thumb ? (swi_imm & 0xFFu) : ((swi_imm >> 16) & 0xFFu);
-        if (g_bios_hle_hook(swi_num)) return;
+        if (g_bios_hle_hook(swi_num)) return false;
     }
 
     // Switch to SVC mode. SPSR_svc gets the pre-SWI CPSR. LR_svc gets
@@ -1221,10 +1260,21 @@
     // (enter_swi sets I=1, then pump_step(3), then the next-boundary IRQ
     // check sees I=1). The recompiled SWI codegen does not tick this op.
     runtime_tick(3u);
+    return true;
+}
 
+}  // namespace
+
+extern "C" void runtime_swi(uint32_t swi_imm) {
+    if (!swi_enter(swi_imm)) return;
     runtime_dispatch(0x00000008u);
 }
 
+extern "C" void runtime_swi_tail(void) {
+    if (!swi_enter(g_runtime_tail_arg)) return;
+    GBARECOMP_TAIL_DISPATCH(0x00000008u);
+}
+
 // Count of IRQ vectorings performed by the recompiled runtime (every
 // runtime_irq call = one exception entry to 0x18). The recomp delivers IRQs
 // here (called from runtime_tick), NOT in runtime.cpp's run loop, so this is
```

Cuidados:
- `dispatch_resolve` e `swi_enter` ficam em `namespace { }` (linkage interno); não entram na ABI.
- Não coloque objetos C++ com destrutor no escopo de `runtime_dispatch_tail`,
  `runtime_dispatch_with_exchange_tail` ou `runtime_swi_tail`: `musttail` recusa a compilação.
- `tests/codegen/stubs.cpp` **não** precisa de stub novo: as três funções vivem no próprio
  `runtime_arm.cpp`, que os testes linkam.

### T5 — Shim do self-heal: `src/runtime/overlay_runtime_arm.h`

```diff
--- a/src/runtime/overlay_runtime_arm.h
+++ b/src/runtime/overlay_runtime_arm.h
@@ -68,6 +68,14 @@
 static inline int  runtime_call_should_return(uint32_t pc) { return g_ovl->runtime_call_should_return(pc); }
 static inline void runtime_call_cancel_return(uint32_t pc) { g_ovl->runtime_call_cancel_return(pc); }
 
+// Guaranteed tail transfers (see runtime_arm.h). Overlays are only ever built
+// natively (gcc as C++, tcc as C), so the shim carries the native expansion
+// alone: byte-for-byte the historical `call; return` text, through the thunks
+// above, with no new callback and no ABI change.
+#define GBARECOMP_TAIL_CALL(fn) fn(); return
+#define GBARECOMP_TAIL_DISPATCH(pc) runtime_dispatch(pc); return
+#define GBARECOMP_TAIL_DISPATCH_WITH_EXCHANGE(pc) runtime_dispatch_with_exchange(pc); return
+
 // ── Timing / scheduling ──
 static inline void runtime_tick(uint32_t c) { g_ovl->runtime_tick(c); }
 static inline int  runtime_should_yield(void) { return g_ovl->runtime_should_yield(); }
@@ -78,6 +86,7 @@
 // ── Exceptions / PSR / mode ──
 static inline void runtime_swi(uint32_t imm) { g_ovl->runtime_swi(imm); }
 static inline void runtime_irq(uint32_t ret) { g_ovl->runtime_irq(ret); }
+#define GBARECOMP_TAIL_SWI(imm) runtime_swi(imm); return
 static inline uint32_t runtime_mrs_cpsr(void) { return g_ovl->runtime_mrs_cpsr(); }
 static inline uint32_t runtime_mrs_spsr(void) { return g_ovl->runtime_mrs_spsr(); }
 static inline void runtime_msr_cpsr(uint32_t v, uint32_t m) { g_ovl->runtime_msr_cpsr(v, m); }
```

`GBA_OVERLAY_ABI_VERSION` fica em **5**. Não alterar `overlay_abi.h`.

### T6 — Build

**`CMakeLists.txt`** — logo após o bloco `if(MSVC) … else() add_compile_options(-Wall …) endif()`
que vem depois do `project()` (antes de qualquer `add_library`/`add_executable`):

```diff
--- a/CMakeLists.txt
+++ b/CMakeLists.txt
@@
 if(MSVC)
     add_compile_options(/W3 /permissive- /Zc:__cplusplus)
 else()
     add_compile_options(-Wall -Wextra -Wno-unused-parameter)
 endif()
+
+# WebAssembly: generated code relies on guaranteed tail calls (runtime_arm.h,
+# GBARECOMP_TAIL_*). Without -mtail-call clang silently ignores musttail, so the
+# header refuses to compile; enable the feature for every target and the link.
+if(EMSCRIPTEN)
+    add_compile_options(-mtail-call)
+    add_link_options(-mtail-call)
+endif()
```

(No protótipo o bloco ficou logo após `set(GBARECOMP_SDL2_OK FALSE)`; ambas as posições vêm
antes de todos os targets e têm o mesmo efeito. A posição acima é a preferida.)

**`cmake/runtime.cmake.in`** (projetos de jogo que usam `gbarecomp_add_runtime_target`):

```diff
--- a/cmake/runtime.cmake.in
+++ b/cmake/runtime.cmake.in
@@ -110,5 +110,11 @@
             GBARECOMP_DEFAULT_GAME_CONFIG="${GR_DEFAULT_GAME_CONFIG_PATH}")
     endif()
 
+    if(EMSCRIPTEN)
+        # Generated code needs guaranteed tail calls (see runtime_arm.h).
+        target_compile_options(${target_name} PRIVATE -mtail-call)
+        target_link_options(${target_name} PRIVATE -mtail-call)
+    endif()
+
     gbarecomp_target_link_host_stack(${target_name} PRIVATE)
 endfunction()
```

**`tools/cli.py`** (template do `CMakeLists.txt` de projetos exportados, ex. `output/pk`):

```diff
--- a/tools/cli.py
+++ b/tools/cli.py
@@ -114,6 +114,10 @@
     CXX_STANDARD 20
     CXX_STANDARD_REQUIRED YES
 )
+if(EMSCRIPTEN)
+    # Generated code needs guaranteed tail calls (see runtime_arm.h).
+    target_compile_options(gbarecomp_game PRIVATE -mtail-call)
+endif()
 '''
     build_ps1 = '''$ErrorActionPreference = "Stop"
 $root = Split-Path -Parent $MyInvocation.MyCommand.Path
```

> `tools/cli.py` já tem uma modificação local não commitada (compatibilidade com Python 3.9,
> `docs/RECOMP_LOG_POKEMON_EMERALD.md` §3a). Aplique este hunk **por cima** dela, sem
> descartá-la, e commite as duas mudanças separadamente (seção 8).

### T7 — Teste de forma: `tests/codegen/gen_codegen_tests.cpp`

Garante a regra de uso das macros (instrução inteira em linha própria) e que a cobertura não
suma sem aviso. No protótipo: 18 transferências de cauda checadas, 131/131 casos passando.

```diff
--- a/tests/codegen/gen_codegen_tests.cpp
+++ b/tests/codegen/gen_codegen_tests.cpp
@@ -45,6 +45,7 @@
         0x080B291Cu,
     };
     std::size_t guarded_trace_sites = 0;
+    std::size_t tail_transfer_sites = 0;
     std::fprintf(f,
         "// generated by gen_codegen_tests — DO NOT EDIT.\n"
         "//\n"
@@ -89,6 +90,33 @@
             ++guarded_trace_sites;
         }
 
+        // Guaranteed tail transfers (runtime_arm.h GBARECOMP_TAIL_*) expand to
+        // TWO statements natively (`call; return`). They are only safe as a
+        // complete statement on its own line inside a braced block; an
+        // unbraced `if (c) GBARECOMP_TAIL_...;` would return unconditionally.
+        for (std::size_t tail_pos = body.find("GBARECOMP_TAIL_");
+             tail_pos != std::string::npos;
+             tail_pos = body.find("GBARECOMP_TAIL_",
+                                  tail_pos + std::strlen("GBARECOMP_TAIL_"))) {
+            const std::size_t line_start = body.rfind('\n', tail_pos);
+            const std::size_t first =
+                (line_start == std::string::npos) ? 0u : line_start + 1u;
+            std::size_t line_end = body.find('\n', tail_pos);
+            if (line_end == std::string::npos) line_end = body.size();
+            const std::string prefix = body.substr(first, tail_pos - first);
+            const std::string line = body.substr(first, line_end - first);
+            if (prefix.find_first_not_of(" \t") != std::string::npos ||
+                line.empty() || line.back() != ';') {
+                std::fprintf(stderr,
+                    "gen_codegen_tests: ERROR — case %zu (%s) emits a "
+                    "GBARECOMP_TAIL_* transfer that is not a whole statement "
+                    "on its own line: %s\n",
+                    i, tc.name, line.c_str());
+                return 6;
+            }
+            ++tail_transfer_sites;
+        }
+
         std::fprintf(f,
             "// [%zu] %s (%s) pc=0x%08X word=0x%08X%s\n"
             "extern \"C\" void tc_%zu(void) {\n"
@@ -126,10 +154,17 @@
         return 5;
     }
 
+    if (tail_transfer_sites == 0) {
+        std::fprintf(stderr,
+            "gen_codegen_tests: ERROR — no GBARECOMP_TAIL_* transfers were "
+            "emitted; the tail-call shape test lost coverage.\n");
+        return 7;
+    }
+
     std::fprintf(stderr,
         "gen_codegen_tests: emitted %zu test functions with %zu guarded trace "
-        "sites to %s\n",
-        kTestCasesCount, guarded_trace_sites, out_path);
+        "sites and %zu tail transfers to %s\n",
+        kTestCasesCount, guarded_trace_sites, tail_transfer_sites, out_path);
     return 0;
 }
```

### T8 — Regenerar (nunca editar `generated/`)

```bash
set -euo pipefail
cd "$R"
cmake --build build-base --target gba_recompile codegen_tests -- -j8   # agora com o código novo
mkdir -p "$W/new/bios" "$W/new/pk"
build-base/gba_recompile --bios bios/gba_bios.bin --config bios/gba_bios.toml --out "$W/new/bios"
build-base/gba_recompile --rom roms/pk.gba --config output/pk/game.toml --out "$W/new/pk/generated"
```

- `src/runtime/generated_bios/bios_dispatch_table.cpp` (versionado) **não muda**: a tabela não
  contém transferências (confirmado em E3). Não regenere dentro de `src/`.
- `output/pk` e qualquer projeto exportado precisam ser regerados com `tools/cli.py build …`
  para receber o `runtime_arm.h` novo e o template CMake novo.
- Consumidores nativos antigos (ex. `MinishCapRecomp/generated`) continuam compilando com o
  header novo (`runtime_dispatch` etc. continuam existindo). Para **web** o jogo precisa ser
  regerado.

---

## 6. Validação

Todos os comandos em **bash**. `R` = raiz do repo, `W` = pasta de T0.
`SHA=f3ae088181bf583e55daf962a92bb46f4f1d07b7`.

### V1 — Testes nativos

```bash
cd "$R/build-base" && ctest -j8          # esperado: 100% tests passed out of 29
./codegen_tests | tail -1                 # esperado: all 131 cases passed
```

A saída do build deve conter `gen_codegen_tests: emitted 131 test functions with 24 guarded trace
sites and 18 tail transfers` (os números podem subir se casos forem adicionados; nunca zero).

### V2 — A/B textual do gerador (prova de nativo inalterado)

```bash
cat > "$W/unmacro.py" <<'EOF'
# Expande GBARECOMP_TAIL_* para o texto nativo histórico e compara byte a byte
# com a saída do gerador antigo. Uso: unmacro.py <dir_antigo> <dir_novo>
import re, sys, pathlib, difflib
pat = re.compile(r'^([ \t]*)GBARECOMP_TAIL_(CALL|DISPATCH|DISPATCH_WITH_EXCHANGE|SWI)\((.*)\);$', re.M)
fn = {"DISPATCH": "runtime_dispatch", "DISPATCH_WITH_EXCHANGE": "runtime_dispatch_with_exchange", "SWI": "runtime_swi"}
def rep(m):
    ind, kind, arg = m.groups()
    call = f"{arg}()" if kind == "CALL" else f"{fn[kind]}({arg})"
    return f"{ind}{call};\n{ind}return;"
old_dir, new_dir = map(pathlib.Path, sys.argv[1:3])
bad = n = macros = 0
for newf in sorted(new_dir.glob("*.cpp")) + sorted(new_dir.glob("*.h")):
    new = newf.read_text(); macros += len(pat.findall(new)); n += 1
    old = (old_dir / newf.name).read_text()
    if pat.sub(rep, new) != old:
        bad += 1; print("DIFF", newf.name)
        for i, l in enumerate(difflib.unified_diff(old.splitlines(), pat.sub(rep, new).splitlines(), lineterm="", n=1)):
            if i > 20: break
            print(l)
print(f"files={n} differing={bad} macros={macros}")
sys.exit(1 if bad or n == 0 or macros == 0 else 0)
EOF
python3 "$W/unmacro.py" "$W/old/bios" "$W/new/bios"            # esperado: files=4 differing=0 macros=1511
python3 "$W/unmacro.py" "$W/old/pk/generated" "$W/new/pk/generated"  # esperado: files=67 differing=0 macros=168341
```

Qualquer `differing>0` **bloqueia** a entrega: significa que a mudança alterou o nativo.

### V3 — A/B de objeto nativo (amostra)

O shard antigo precisa do header antigo; `git stash` só do header resolve sem copiar árvores
(o `runtime_arm_types.h` usa include relativo ao submódulo, por isso não copie headers soltos):

```bash
cd "$R"
git stash push -- src/armv4t/runtime_arm.h        # só o header, só para este passo
c++ -std=c++20 -O3 -DNDEBUG -c -Isrc/armv4t -I"$W/old/pk/generated" "$W/old/pk/generated/recompiled_000.cpp" -o "$W/old000.o"
git stash pop
c++ -std=c++20 -O3 -DNDEBUG -c -Isrc/armv4t -I"$W/new/pk/generated" "$W/new/pk/generated/recompiled_000.cpp" -o "$W/new000.o"
objdump -d --no-show-raw-insn "$W/old000.o" | tail -n +3 > "$W/old.dis"
objdump -d --no-show-raw-insn "$W/new000.o" | tail -n +3 > "$W/new.dis"
test -s "$W/old.dis" && cmp "$W/old.dis" "$W/new.dis" && echo IDENTICAL
```

Esperado: `IDENTICAL` (no protótipo: 266.975 linhas). **Sempre** confira `test -s` antes do
`cmp`: comparar dois arquivos vazios "passa" (armadilha 10.2).

### V4 — Overlay de self-heal com tcc e gcc

Precisa de um `tcc` (Windows: o do `tools/fetch_tcc.ps1`; macOS/Linux: compilar do fonte
`https://github.com/TinyCC/tinycc` com `./configure --prefix=$W/tcc && make && make install`).

```bash
cat > "$W/mkovl.py" <<'EOF'
# Monta um overlay no formato de src/runtime/overlay_emit.cpp a partir de uma função real do
# BIOS novo (sem alias de resume e sem chamadas diretas por nome, como os overlays reais),
# acrescenta um SWI sintético e grava new_overlay.c e old_overlay.c (texto nativo histórico).
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text()
funcs = re.findall(r'^void (\w+)\(void\) \{\n(.*?)^\}\n', src, re.M | re.S)
skip = re.compile(r'^\s+\w+\(\);$|GBARECOMP_TAIL_CALL|g_runtime_resume_pc', re.M)
name, body = next((n, b) for n, b in funcs if not skip.search(b)
                  and "GBARECOMP_TAIL_DISPATCH_WITH_EXCHANGE" in b and "GBARECOMP_TAIL_DISPATCH(" in b)
body = body.replace("    /* fall-through",
    "    if (g_cpu.R[0] == 0x1234u) {\n    GBARECOMP_TAIL_SWI(0x00000005u);\n    }\n    /* fall-through", 1)
prelude = '''// AUTO-GENERATED Stage-2 self-heal overlay. Do not edit.
#include "overlay_runtime_arm.h"

#ifdef _WIN32
#define OVL_DLLEXPORT __declspec(dllexport)
#else
#define OVL_DLLEXPORT __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
#define OVL_EXPORT extern "C" OVL_DLLEXPORT
#else
#define OVL_EXPORT OVL_DLLEXPORT
#endif

const GbaOverlayCallbacks* g_ovl = 0;
OVL_EXPORT uint32_t overlay_abi(void) { return 5u; }
OVL_EXPORT void overlay_init(const GbaOverlayCallbacks* cb) { g_ovl = cb; }

'''
out = prelude + "OVL_EXPORT void func_TEST(void) {\n" + body + "}\n"
pat = re.compile(r'^([ \t]*)GBARECOMP_TAIL_(DISPATCH|DISPATCH_WITH_EXCHANGE|SWI)\((.*)\);$', re.M)
fn = {"DISPATCH": "runtime_dispatch", "DISPATCH_WITH_EXCHANGE": "runtime_dispatch_with_exchange", "SWI": "runtime_swi"}
pathlib.Path("new_overlay.c").write_text(out)
pathlib.Path("old_overlay.c").write_text(pat.sub(lambda m: f"{m.group(1)}{fn[m.group(2)]}({m.group(3)});\n{m.group(1)}return;", out))
print("picked", name, "macros", len(pat.findall(out)))
EOF
TCC=${TCC:-tcc}   # caminho do tcc (ex.: $W/tcc/bin/tcc)
mkdir -p "$W/ovl" && cd "$W/ovl" && python3 "$W/mkovl.py" "$W/new/bios/bios_recompiled.cpp"
INC="-I$R/src/runtime -I$R/src/armv4t"
# novo texto com o shim novo
"$TCC" -shared $INC -o new_tcc.so new_overlay.c
c++ -O2 -std=gnu++17 -fno-exceptions -fno-rtti -shared $INC -o new_gxx.so -x c++ new_overlay.c
# texto antigo com o shim antigo (git stash só do shim)
(cd "$R" && git stash push -- src/runtime/overlay_runtime_arm.h)
"$TCC" -shared $INC -o old_tcc.so old_overlay.c
c++ -O2 -std=gnu++17 -fno-exceptions -fno-rtti -shared $INC -o old_gxx.so -x c++ old_overlay.c
(cd "$R" && git stash pop)
for k in tcc gxx; do
  objdump -d --no-show-raw-insn new_$k.so | tail -n +3 | sed 's/new_overlay\.c/X.c/g' > n_$k
  objdump -d --no-show-raw-insn old_$k.so | tail -n +3 | sed 's/old_overlay\.c/X.c/g' > o_$k
  test -s n_$k && cmp n_$k o_$k && echo "$k IDENTICAL"
done
```

Esperado: `tcc IDENTICAL` e `gxx IDENTICAL`. O `sed` remove o rótulo derivado do nome do
arquivo que o objdump imprime para o tcc (única diferença observada, não é código).
No Linux troque `-shared` do c++ por `-shared -fPIC`.

Execução real do self-heal (opcional, se houver MinishCapRecomp): `tests/selfheal/stage2_bios_identical.sh`
deve continuar verde.

### V5 — Build wasm (runtime + jogo) com o código novo

```bash
source ~/emsdk/emsdk_env.sh
E=~/emsdk/upstream/emscripten/cache/sysroot
cd "$R"
# 5a. runtime multithread (PROXY_TO_PTHREAD)
emcmake cmake -S . -B build-wasm-mt -DCMAKE_BUILD_TYPE=Release -DGBARECOMP_COMPILER_CACHE=OFF \
  -DCMAKE_C_FLAGS=-pthread -DCMAKE_CXX_FLAGS=-pthread \
  -DSDL2_INCLUDE_DIR=$E/include/SDL2 -DSDL2_LIBRARY=$E/lib/wasm32-emscripten/libSDL2.a \
  -DGBARECOMP_GENERATED_BIOS_DIR="$W/new/bios"
cmake --build build-wasm-mt --target gbarecomp_runtime gbarecomp_debug gbarecomp_gba \
  gbarecomp_armv4t gbarecomp_recompile_core gbarecomp_heal_gate -- -k -j8
grep -q -- "-mtail-call" build-wasm-mt/CMakeFiles/gbarecomp_armv4t.dir/flags.make && echo "flag ok"
# 5b. runtime single-thread: mesmo comando com -B build-wasm-st e SEM os -pthread
# 5c. projeto do jogo (regerado) — scaffold via cli.py, que já leva o header e o template novos
python3 - <<EOF
import sys; from pathlib import Path
sys.path.insert(0, "$R/tools"); import cli
out = Path("$W/new/pk"); cli.copy_framework(out); cli.write_project(out, Path("$R/roms/pk.gba"), True)
EOF
grep -q -- "-mtail-call" "$W/new/pk/CMakeLists.txt" && echo "template ok"
emcmake cmake -S "$W/new/pk" -B "$W/new/pk/build-wasm-mt" -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-pthread
cmake --build "$W/new/pk/build-wasm-mt" -- -j8
emcmake cmake -S "$W/new/pk" -B "$W/new/pk/build-wasm-st" -DCMAKE_BUILD_TYPE=Release
cmake --build "$W/new/pk/build-wasm-st" -- -j8
```

Configure deve imprimir `gbarecomp: BIOS recompiled output present — linking`.
Se imprimir `SDL2 NOT found`, o build não testou a janela (armadilha 10.6).

### V6 — Contagem de `return_call`

```bash
OD=~/emsdk/upstream/bin/llvm-objdump
$OD -d $(find "$R/build-wasm-mt" -name runtime_arm.cpp.o) | grep -c return_call          # esperado: 3
$OD -d $(find "$R/build-wasm-mt" -name bios_recompiled.cpp.o) | grep -c return_call      # esperado: ~1204 (>1000)
$OD -d $(find "$W/new/pk/build-wasm-mt" -name recompiled_000.cpp.o) | grep -c return_call # esperado: ~2138 (antes: 0)
```

### V7 — Proteção contra build sem `-mtail-call`

```bash
printf '#include "runtime_arm.h"\nvoid probe(void) { GBARECOMP_TAIL_DISPATCH(0x08000000u); }\n' > "$W/neg.cpp"
em++ -std=c++20 -O2 -I"$R/src/armv4t" -c "$W/neg.cpp" -o "$W/neg.o"; echo "exit=$?"   # esperado: erro com a mensagem do #error, exit≠0
em++ -std=c++20 -O2 -mtail-call -I"$R/src/armv4t" -c "$W/neg.cpp" -o "$W/neg.o" && \
  ~/emsdk/upstream/bin/llvm-objdump -d "$W/neg.o" | grep -c return_call                   # esperado: 1
```

### V8 — Execução em node + paridade com o nativo

Link (host mínimo; `main` vem do jogo em builds reais):

```bash
mkdir -p "$W/link" && cd "$W/link"
printf '#include "runtime.h"\nint main(int argc, char** argv) { return gbarecomp::run_game(argc, argv); }\n' > main.cpp
INCS="-I$R/src/runtime -I$R/src/armv4t -I$R/src/gba -I$R/src/debug -I$R/external/arm-recomp-core/profiles/armv4t_gba"
libs() { echo "-Wl,--start-group $1/libgbarecomp_runtime.a $1/libgbarecomp_debug.a $1/libgbarecomp_gba.a $1/libgbarecomp_armv4t.a $1/libgbarecomp_recompile_core.a $1/libgbarecomp_heal_gate.a $2/libgbarecomp_game.a -Wl,--end-group"; }
em++ -O2 -std=c++20 -pthread -mtail-call $INCS main.cpp $(libs "$R/build-wasm-mt" "$W/new/pk/build-wasm-mt") \
  -sUSE_SDL=2 -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=16777216 \
  -sDEFAULT_PTHREAD_STACK_SIZE=16777216 -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=4 \
  -sNODERAWFS=1 -sEXIT_RUNTIME=1 --emit-symbol-map -o pk_mt.js
em++ -O2 -std=c++20 -mtail-call $INCS main.cpp $(libs "$R/build-wasm-st" "$W/new/pk/build-wasm-st") \
  -sUSE_SDL=2 -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=16777216 \
  -sNODERAWFS=1 -sEXIT_RUNTIME=1 --emit-symbol-map -o pk_st.js
grep -c "gf_" pk_mt.js.symbols    # esperado: 99274
```

A referência nativa `"$W/link/pk_native_old"` foi produzida em **T0.b** (código antigo).

Execução — **cada run numa pasta descartável própria** (o runtime grava `recomp_cache/`,
`.sav`, `recomp_coverage_*.json` e `recomp_master_misses_*.toml.frag` no diretório atual):

```bash
run() {  # run <pasta> <frames> <comando...>
  local d="$W/runs/$1" fr=$2; shift 2
  mkdir -p "$d" && cp "$R/roms/pk.gba" "$R/bios/gba_bios.bin" "$d/"
  (cd "$d" && env GBARECOMP_SELFHEAL_RECOMPILE=0 "$@" --rom pk.gba --bios gba_bios.bin \
     --rom-sha1 $SHA --no-window --frames $fr > run.log 2>&1; echo "exit=$?" >> run.log)
}
run native-1800  1800  "$W/link/pk_native_old"
run mt-1800      1800  node "$W/link/pk_mt.js"
run st-1800      1800  node "$W/link/pk_st.js"
run native-10800 10800 "$W/link/pk_native_old"
run mt-10800     10800 node "$W/link/pk_mt.js"
run st-10800     10800 node "$W/link/pk_st.js"
run st-10800-128k 10800 node --stack-size=128 "$W/link/pk_st.js"

sig() { grep -E "final_pc|self_heal_coverage|nonzero|bridged" "$W/runs/$1/run.log"; }
for fr in 1800 10800; do for v in mt st; do
  diff <(sig native-$fr) <(sig $v-$fr) >/dev/null && echo "$v-$fr == native" || echo "$v-$fr DIFFERS"
  cmp "$W/runs/native-$fr/recomp_master_misses_BPEE.toml.frag" "$W/runs/$v-$fr/recomp_master_misses_BPEE.toml.frag" && echo "  misses frag identical"
done; done
grep -l RangeError "$W"/runs/*/run.log && echo "FALHOU: RangeError" || echo "sem RangeError"
grep "exit=" "$W"/runs/*/run.log
```

Esperado (medido no protótipo):

| Run | Resultado |
|---|---|
| todos | `exit=0`, sem `RangeError` |
| `*-1800` | `final_pc=0x080008ca … steps=4160`, `dispatch_misses=36 interpreted_insns=38016147` |
| `*-10800` | `final_pc=0x080008c6 … steps=11512`, `dispatch_misses=54 interpreted_insns=269727239` |
| mt/st × native | linhas de assinatura e `.toml.frag` idênticos |
| `st-10800-128k` | passa |

Contraprova opcional (recomendada uma vez): linkar as libs wasm **antigas** com os mesmos
comandos (sem `-mtail-call`) e rodar `mt-1800`/`st-1800` → deve dar `RangeError`.

Os números de misses **não** são critério de "FULLY_STATIC": eles medem paridade. Ver 9.1.

### V9 — Windows (se houver acesso)

Repetir V1, V2 e V4 com MinGW gcc e o tcc empacotado. Critério idêntico. Se não houver
Windows disponível, registrar explicitamente no PR que não foi validado lá.

---

## 7. Critérios de aceite

- [ ] V1: `ctest` 29/29 e `codegen_tests` 131/131; `gen_codegen_tests` reporta >0 tail transfers.
- [ ] V2: `differing=0` para BIOS e `pk`.
- [ ] V3: disassembly nativa idêntica (shard 000, `-O3`).
- [ ] V4: overlay tcc e gcc idênticos ao texto antigo.
- [ ] V6: `return_call` = 3 no runtime, >1000 no BIOS, >2000 no shard 000.
- [ ] V7: build wasm sem `-mtail-call` falha com a mensagem do `#error`.
- [ ] V8: 1.800 e 10.800 frames sem `RangeError` em MT e ST; paridade com nativo; ST com
      `--stack-size=128` passa.
- [ ] `GBA_OVERLAY_ABI_VERSION` continua 5; `overlay_abi.h` intocado.
- [ ] Nenhuma edição em `generated/` nem em `src/runtime/generated_bios/`.
- [ ] Submódulo commitado e ponteiro atualizado no `gbarecomp` (seção 8).
- [ ] Documentação atualizada (seção 11).

---

## 8. Commits

1. **Submódulo `external/arm-recomp-core`** (remoto `github.com/mstan/arm-recomp-core`): commit só
   com `profiles/armv4t_gba/arm_codegen.cpp`. Se não houver permissão de push, abrir PR/fork e
   usar o commit do fork temporariamente.
   - Antes: o volume exFAT cria `._*` (AppleDouble) inclusive em `.git/modules/external/arm-recomp-core/`
     (48 arquivos hoje), o que gera `error: non-monotonic index`. É ruído para leitura, mas pode
     atrapalhar escrita de objetos/pack. Rodar `dot_clean -m .git/modules/external/arm-recomp-core`
     **somente com confirmação de quem é dono do repo** — nunca apagar `._*` às cegas.
   - Os `._*` aparecem como untracked no submódulo (`._.git`, `._CMakeLists.txt`…): **não** adicionar.
2. **`gbarecomp`**, commit A (independente, já existia localmente): compatibilidade Python 3.9 em `tools/cli.py`.
3. **`gbarecomp`**, commit B: T2–T7 + bump do ponteiro do submódulo + este documento/atualizações da seção 11.
   Não commitar `output/`, `roms/`, `build-*`, `._*`.

---

## 9. Limitações conhecidas (fora do escopo desta mudança)

### 9.1 `pk` não é FULLY_STATIC

Mesmo no nativo antigo: 36 misses em 1.800 frames e 54 em 10.800 (código em IWRAM
`0x03001AA8`, `0x03002750`, `0x0300287C`, `0x03007Dxx`; funções não descobertas em
`0x080AA4xx`, `0x0816Dxxx`–`0x0817Bxxx`, `0x082DF7E4`–`0x082E1628`; e `0x08000000`).
No navegador não há self-heal (`WEB_WASM_PORT.md` §3), então **o port web continua bloqueado
pelo loop de cobertura do `CLAUDE.md`**, não pelas tail calls. Código executado da RAM
(`0x03xxxxxx`) exige decisão própria (não é resolvível só com `[[extra_func]]` na ROM).

### 9.2 Aborto pré-existente com gameplay

Com input replay (START/A por ~10.000 frames) o nativo antigo aborta com
`SELF-HEAL bridge for 0x080008C8 exceeded 200000000 instructions without returning to
stop_pc=0x082DFB5E`. O wasm novo aborta **igual** (MT e ST). É bug de ponte/cobertura do `pk`
a investigar pelo `DEBUG.md`, não desta mudança.

### 9.3 Caminhos que continuam não-cauda por desenho

- `runtime_bridge_interpret` (force-interp hook e miss bridge), `g_runtime_ram_dispatch_hook`
  e `overlay_try_dispatch` chamam código e voltam. Em jogo FULLY_STATIC sem esses hooks não
  participam de loops. Um jogo que use `g_runtime_ram_dispatch_hook` em loop quente pode crescer
  a pilha no wasm — medir antes de liberar esse jogo para web.
- BL/BLX e IRQ: limitados por profundidade do guest (1.3).

### 9.4 Não está neste plano

Gate `__EMSCRIPTEN__` do self-heal (`backend=gcc` enganoso), `[rom].sha1` no TOML de runtime,
`index.html`, COOP/COEP, áudio por gesto, IDBFS para `.sav`, pré-carregamento. Ver
`WEB_WASM_EXPERIMENTS.md` §10.

---

## 10. Armadilhas (já custaram tempo — não repetir)

1. **zsh não faz word-splitting de variáveis.** `F="-O3 -c"; c++ $F …` passa um argumento só
   (e o `-c` some → vira link com milhares de "Undefined symbols"). Rode os scripts em `bash`
   ou use `${=F}` no zsh. Heredoc sem aspas (`<<EOF`) expande backticks: use `<<'EOF'`.
2. **`cmp` de dois arquivos vazios "passa".** Sempre `test -s` antes de declarar IDENTICAL.
3. **Pasta descartável por run.** O runtime grava `recomp_cache/`, `.sav`, coverage e misses no cwd.
4. **`gba_recompile --bios` sem `--out` sobrescreve `src/runtime/generated_bios/`.**
5. **`[[clang::musttail]]` sem `-mtail-call` é ignorado com warning.** Por isso o `#error`.
   Não "resolva" um erro de build removendo a proteção.
6. **Configure wasm sem SDL não reclama** (`SDL2 NOT found — host_window will stub out`).
7. **`symbol_map.cpp` some quando linkado de archive** sem `--whole-archive` (só nomes de debug).
8. **Não usar `--bios-hle`** para fazer nada passar (proibido pelo `CLAUDE.md`).
9. **`--stack-size` do node acima do limite da thread do SO** pode dar segfault. Para medir
   margem, **reduza** (128/256), não aumente.
10. **Não reintroduzir `do { } while (0)` nas macros:** quebra a identidade nativa em `-O0` e o
    A/B token a token (V2 continua passando, mas V3 em `-O0` e o raciocínio de "texto idêntico" não).
11. **Macro de cauda só como instrução inteira em linha própria dentro de chaves** (T7 verifica
    os casos do corpus de teste; revise à mão qualquer novo site no gerador).

---

## 11. Atualizações de documentação (parte do commit B)

- `docs/WEB_WASM_EXPERIMENTS.md`: §4.3/§6 — marcar como **implementado**, apontar para este
  documento e colar a tabela E11–E17.
- `docs/WEB_WASM_PORT.md`: §4 Build — incluir `-mtail-call` (compile e link) como obrigatório;
  §7 (correções) — "tail calls são pré-requisito, garantidas por `GBARECOMP_TAIL_*`".
- `docs/WEB_WASM_TAILCALL_PLAN.md`: no topo, `Status: concluído — ver WEB_WASM_TAILCALL_IMPLEMENTATION.md`.
- Suporte de navegador: tail calls wasm são "Baseline Newly available" desde dez/2024
  (Chrome/Edge, Firefox e Safari atuais). Antes do lançamento web, conferir a tabela oficial
  em webassembly.org/features e registrar as versões mínimas no `WEB_WASM_PORT.md`
  (referência de memória, a confirmar: Chrome 112, Firefox 121, Safari 18.2).

---

## 12. Execução real (2026-09-13)

Ambiente: macOS arm64, Apple clang 21, Emscripten 6.0.9, node do emsdk **24.19.0** (não
24.14.1), tcc 0.9.28rc mob@0fb54300 compilado do fonte, Python 3.9.6.

| Verificação | Resultado |
|---|---|
| T0 baseline | `ctest` 29/29 no código antigo; `pk_native_old` linkado |
| V1 | `ctest` 29/29; `codegen_tests` 131/131; `emitted 131 test functions with 24 guarded trace sites and 18 tail transfers` ✅ |
| V2 | BIOS `files=4 differing=0 macros=1511`; `pk` `files=67 differing=0 macros=168341` ✅ |
| V3 | shard 000 `-O3`: disassembly idêntica (266.975 linhas) ✅ |
| V4 | overlay c++ idêntico (61 linhas); tcc idêntico (272 linhas, rótulo de arquivo normalizado — ver desvio 3) ✅ |
| V6 | `return_call`: runtime 3, BIOS 1.204, shard 000 2.138 ✅ |
| V7 | sem `-mtail-call`: `#error` dispara; com a flag: `return_call=1` ✅ |
| V8 | MT/ST × 1.800/10.800 frames: assinatura (40/58 linhas) e `.toml.frag` idênticos ao nativo antigo; `st --stack-size=128` passa; sem `RangeError`; todos `exit=0` ✅ |
| Tamanho | `pk_mt.wasm` 78.024.717 bytes; `pk_st.wasm` 77.962.180 bytes |

`GBA_OVERLAY_ABI_VERSION` continua 5; nada foi editado em `generated/` nem em
`src/runtime/generated_bios/`. V9 (Windows) **não** foi executado: sem acesso a Windows.

### Desvios em relação aos comandos das seções 5–6

1. **Pastas de build separadas.** O baseline ficou em `build-base` e o código novo foi compilado do
   zero em `build/` (BIOS novo em `build/generated_bios`). O documento reusa `build-base` em T8, o
   que sobrescreve as libs antigas; com pastas separadas T0.b e V8 não dependem da ordem.
2. **V3 sem `git stash`.** O shard antigo foi compilado com os headers antigos que o
   `cli.copy_framework` já copiou para `$W/old/pk/framework/include` em T0.b. Mesmo efeito, sem
   mexer na árvore de trabalho.
3. **V4 com tcc:** se `old_overlay.c` e `new_overlay.c` estiverem em pastas diferentes (necessário
   para pegar o shim antigo por include relativo sem `git stash`), o objdump do tcc imprime o
   caminho no rótulo (`<oldshim/X.c+0x4000>`). Normalizar o caminho inteiro antes do `cmp`. As 15
   linhas diferentes eram só esse rótulo.
4. **zsh:** `PIPESTATUS` não existe no zsh (`pipestatus`); a metade positiva do V7 precisou ser
   refeita em bash. Mais um motivo para a regra "scripts em bash" (armadilha 10.1).
5. **Projeto do jogo:** `output/pk` foi regerado do zero com `tools/cli.py build`, e não em `$W`;
   o A/B do V2 comparou `$W/old/pk/generated` com `output/pk/generated`.

### Casca web e primeiro teste em navegador

O bundle de navegador (`packaging/web/`) e os erros encontrados no primeiro teste estão em
`docs/WEB_WASM_EXPERIMENTS.md` §11.
