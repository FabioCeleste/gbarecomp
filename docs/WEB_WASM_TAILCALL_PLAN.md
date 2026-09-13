# WEB_WASM_TAILCALL_PLAN — plano para tail calls garantidas no código gerado

**Data:** 2026-09-13
**Status:** concluído — ver `docs/WEB_WASM_TAILCALL_IMPLEMENTATION.md` (implementado na
branch `feat/web-wasm-tailcall`).
**Pré-leitura:** `docs/WEB_WASM_EXPERIMENTS.md` (seções 4.3 e 5: causa raiz do
estouro de pilha no wasm).

---

## 1. Objetivo

Fazer o código gerado rodar no WebAssembly sem estourar a pilha do V8, garantindo
que os desvios do guest que hoje viram `chamada C + return` se tornem saltos
(`return_call`) — **sem mudar o comportamento nativo** e respeitando o
`CLAUDE.md` (mudança no gerador/runtime, nunca em `generated/`).

Critério de sucesso resumido: `pk` rodando ≥ 10.800 frames (3 min de jogo) em
node com a stack padrão do V8, `FULLY_STATIC`, e o build nativo com
comportamento idêntico ao de hoje.

---

## 2. A proposta (dica do senior)

> Macro no código gerado: o gerador passa a emitir sempre
> `GBARECOMP_TAIL return gf_x();`, e a macro é definida no header:
>
> ```c
> #if defined(__EMSCRIPTEN__)
> #  define GBARECOMP_TAIL [[clang::musttail]]
> #else
> #  define GBARECOMP_TAIL   /* nativo: nada muda */
> #endif
> ```
>
> Assim existe um código gerado só, e quem escolhe o comportamento é o
> compilador (em++ ou nativo). No nativo a macro fica vazia e o resultado é
> igual ao de hoje. Não precisa de flag nenhuma na recompilação, só regenerar
> uma vez depois da mudança no gerador. E isso respeita o CLAUDE.md: a mudança
> fica no gerador, nunca em `generated/`.

**A direção está certa e é a adotada neste plano.** Ela tem quatro pontos cegos,
verificados durante a preparação, que precisam ser resolvidos antes de
implementar (seção 4).

---

## 3. Fatos já verificados

| # | Fato | Como foi verificado |
|---|---|---|
| F1 | No wasm, função com mais de um `return` perde a tail call mesmo com `-mtail-call` | Bissecção, `WEB_WASM_EXPERIMENTS.md` §5.4 |
| F2 | `[[clang::musttail]]` força `return_call` para `gf_x()` (`void(void)`→`void(void)`) mesmo com vários `return` | Teste isolado, em++ 6.0.9 `-O3 -mtail-call` |
| F3 | `musttail` para `runtime_dispatch(uint32_t)` a partir de `void(void)` é **rejeitado**: *"target function has different number of parameters (expected 0 but has 1)"* | Teste isolado |
| F4 | Sem `-mtail-call`, o em++ **ignora** `[[clang::musttail]]` só com warning (*"unknown attribute ignored"*) | Teste isolado |
| F5 | Com `-mtail-call` o compilador define `__wasm_tail_call__ 1`; sem a flag não define | `em++ -dM -E` |
| F6 | No clang nativo (arm64, `-O2`), `f(); return;` e `return f();` geram **objeto idêntico** (`diff` do objdump vazio), inclusive com vários `return` | Teste isolado com `/usr/bin/clang++` |
| F7 | O overlay de self-heal compila o **mesmo texto gerado** como C++ no gcc (`-x c++ -std=gnu++17`) e como **C** no tcc | `src/runtime/overlay_compile.cpp:338-382` |
| F8 | O codegen de instruções fica no **submódulo** `external/arm-recomp-core` (`profiles/armv4t_gba/arm_codegen.cpp`); o fall-through fica em `src/recompile/emit_function.cpp:401` | grep |

Não verificado: gcc/MinGW (Windows) com a forma `return f();`; comportamento do
tcc com `return f();` em função `void`.

---

## 4. Pontos cegos da proposta

### 4.1 A recursão observada passa pelo `runtime_dispatch` — a macro sozinha não resolve

O trace do estouro era
`runtime_dispatch → _00000C04 → bios_resume_0C0C → runtime_dispatch → …`:

- `bios_resume_0C0C` chama `_00000C04()` direto → coberto pela proposta.
- `_00000C04` termina com `runtime_dispatch(0x00000C0Cu); return;`
  (fall-through, `emit_function.cpp:401`) → **não coberto**: F3 impede o
  `musttail` por diferença de assinatura.
- `runtime_dispatch` (`src/armv4t/runtime_arm.cpp:819`) termina com
  `entry->fn(); return;` → `void(uint32_t)` chamando `void(void)` →
  **mesmo problema no sentido inverso**.

Com só `gf_x()` protegido, **a cadeia continua crescendo pelo dispatch**.

**Opções para investigar:**

| Opção | Ideia | Prós | Contras |
|---|---|---|---|
| **A (preferida)** | Dispatch `void(void)`: `g_runtime_dispatch_pc = x; GBARECOMP_TAIL return runtime_dispatch_pending();` e dentro dele `GBARECOMP_TAIL return entry->fn();` | Assinaturas batem nos dois sentidos; o `runtime_dispatch(uint32_t)` antigo continua existindo para o resto do runtime | Uma global a mais; precisa entrar na ABI do overlay (`GbaOverlayCallbacks`) |
| B | Todas as funções geradas passam a receber `uint32_t` | Sem global | Muda a ABI de 99 mil funções, a dispatch table e o overlay; bem mais invasivo |
| C | Trampolim (funções retornam o próximo alvo) | Não depende de `musttail` | Reescrita grande do codegen e custo nativo |

### 4.2 O em++ precisa de `-mtail-call`, e sem ela a macro falha em silêncio

"Não precisa de flag" vale para o `gba_recompile`, mas **não** para o em++ (F4).
Sem a flag, o build passa e estoura em execução — exatamente o que queremos
evitar. Proteção proposta (usa F5):

```c
#if defined(__EMSCRIPTEN__) && !defined(__wasm_tail_call__)
#  error "gbarecomp: compile o código gerado com -mtail-call (tail calls garantidas)"
#endif
```

E adicionar `-mtail-call` no branch Emscripten do CMake (compilação e link).

### 4.3 `return f();` em função `void` é inválido em C (tcc do self-heal)

A forma literal `GBARECOMP_TAIL return gf_x();` gera texto que o tcc compila
como C (F7). Em C, `return` com expressão numa função `void` viola a norma; o
comportamento do tcc **não foi testado** e pode quebrar o self-heal nativo.

**Ajuste proposto (mesmo princípio do senior, texto válido em C e C++):**
macro com função, emitida pelo gerador como `GBARECOMP_TAIL_CALL(gf_x());`:

```c
#if defined(__EMSCRIPTEN__)
#  define GBARECOMP_TAIL_CALL(call) do { [[clang::musttail]] return call; } while (0)
#else
#  define GBARECOMP_TAIL_CALL(call) do { call; return; } while (0)
#endif
```

- Nativo: expande **exatamente** para o texto de hoje (`gf_x(); return;`).
- Um código gerado só; quem decide é o compilador.
- **A verificar:** se o `musttail` é aceito dentro de `do { } while (0)` (a norma
  do atributo exige `return` em posição de cauda; um bloco sem código depois
  deve servir, mas precisa de teste). Alternativa: `{ [[clang::musttail]] return call; }`
  sem o `do/while`.

Se o tcc aceitar `return f();` sem problema, a forma original do senior também
serve — decidir após o teste da Fase 0.

### 4.4 A mudança atravessa um submódulo e três cópias de header

- Codegen em `external/arm-recomp-core` (remote relativo `../arm-recomp-core.git`):
  exige commit no submódulo **e** bump do ponteiro no `gbarecomp`.
- Headers do ABI:
  - `src/armv4t/runtime_arm.h` (runtime)
  - `src/armv4t/runtime_arm_types.h`, `external/arm-recomp-core/common/runtime_arm_types.h`,
    `external/arm-recomp-core/profiles/armv4t_gba/runtime_arm_types.h`
  - `src/runtime/overlay_runtime_arm.h` (shim do self-heal; também precisa da macro)
  - `tools/cli.py:17` copia `runtime_arm.h` e `runtime_arm_types.h` para
    `output/<jogo>/framework/include` → projetos exportados precisam ser
    regenerados.
- **A decidir:** o lugar único da macro. Candidato: o `runtime_arm_types.h` do
  profile, se ele for incluído tanto pelo `runtime_arm.h` quanto pelo shim do
  overlay (confirmar a cadeia de `#include` de `overlay_abi.h`).

---

## 5. Inventário dos pontos de emissão

`external/arm-recomp-core/profiles/armv4t_gba/arm_codegen.cpp` (linhas do commit
`763b922`) e `src/recompile/emit_function.cpp`:

| Local | Emite hoje | Tipo | Ação |
|---|---|---|---|
| `arm_codegen.cpp:423` + `:443` | `gf_x();` … `return;` (B com nome conhecido) | cauda direta | `GBARECOMP_TAIL_CALL(gf_x())` |
| `arm_codegen.cpp:429` + `:443` | `runtime_dispatch(0x…);` … `return;` (B sem nome) | cauda via dispatch | opção A (4.1) |
| `arm_codegen.cpp:419-421` | nada + `return;` (self-loop `b .`) | volta ao loop | manter |
| `arm_codegen.cpp:437-440` | `if (PC != LR) { runtime_call_cancel_return(); return; }` (BL) | **não é cauda** | manter |
| `arm_codegen.cpp:678-684` | `runtime_dispatch(pc_var); return;` (escrita em PC por data-processing) | cauda via dispatch | opção A |
| `arm_codegen.cpp:732-739` | `runtime_dispatch_with_exchange(target); return;` (BX) | cauda via dispatch | opção A (variante exchange) |
| `arm_codegen.cpp:768-772` | `runtime_dispatch(target);` + checagem de retorno (BLX) | **não é cauda** | manter |
| `arm_codegen.cpp:874-875` | `runtime_dispatch(val & ~1u); return;` (LDR para PC) | cauda via dispatch | opção A |
| `arm_codegen.cpp:964-965` | `runtime_dispatch(g_cpu.R[15]); return;` | cauda via dispatch | opção A |
| `arm_codegen.cpp:1083-1088` | `runtime_dispatch(g_cpu.R[15]); return;` (POP/LDM com PC) | cauda via dispatch | opção A |
| `arm_codegen.cpp:1268-1270` | `runtime_swi(imm); return;` | cauda para o BIOS | investigar se entra em cadeia recursiva |
| `arm_codegen.cpp:1288-1290`, `:1396-1398` | `runtime_unimplemented_op(…); return;` | aborta | manter |
| `emit_function.cpp:398-402` | `runtime_dispatch(end); return;` (fall-through) | cauda via dispatch | opção A |
| `src/armv4t/runtime_arm.cpp:849` | `entry->fn(); return;` dentro do dispatch | cauda indireta | `GBARECOMP_TAIL_CALL(entry->fn())` no dispatch `void(void)` |
| `src/armv4t/runtime_arm.cpp` (`runtime_dispatch_with_exchange`) | `runtime_dispatch(target_pc);` | cauda | idem |

Fora de escopo: `profiles/armv5te_nds` (usa `runtime_unwinding()`, outro modelo).

As chamadas de BL/BLX **não** são cauda por natureza: o host volta para a
função depois do callee. A profundidade delas é limitada pela profundidade de
chamadas do guest.

---

## 6. Fases

### Fase 0 — experimentos isolados (scratchpad, sem tocar no repo)

1. **musttail + tcc:** compilar com tcc (o mesmo que `overlay_compile.cpp` usa)
   um trecho com `return f();` em função `void` e com `GBARECOMP_TAIL_CALL`
   expandido para o nativo. Registrar se passa, avisa ou falha.
2. **musttail dentro de `do { } while (0)`** e dentro de `{ }` com em++
   `-O3 -mtail-call`: confirmar que compila e gera `return_call`.
3. **Protótipo da opção A:** arquivo com `g_runtime_dispatch_pc`,
   `runtime_dispatch_pending(void)` com `musttail` para `entry->fn()`, e funções
   de teste que fazem loop mútuo 10 milhões de vezes. Rodar em node com a stack
   padrão: tem que terminar sem `RangeError`.
4. **gcc/MinGW:** confirmar que `GBARECOMP_TAIL_CALL` vazio produz o mesmo objeto
   que o texto atual (repetir o teste F6 com gcc).
5. **Onde a macro mora:** mapear a cadeia de `#include` de `runtime_arm.h` e de
   `overlay_runtime_arm.h`/`overlay_abi.h` e escolher um header único.

**Saída:** decisão registrada entre forma original e `GBARECOMP_TAIL_CALL`, e
entre opções A/B/C para o dispatch.

### Fase 1 — header e runtime

1. Macro (e o `#error` da seção 4.2) no header escolhido.
2. `runtime_dispatch_pending(void)` (ou nome equivalente) em
   `src/armv4t/runtime_arm.cpp`, reaproveitando a lógica atual; o
   `runtime_dispatch(uint32_t)` existente delega para ele.
3. Expor na ABI do overlay (`src/runtime/overlay_abi.h`,
   `overlay_runtime_arm.h`) e **incrementar a versão da ABI** do overlay, já
   que os DLLs em cache ficam incompatíveis.
4. Branch `EMSCRIPTEN` no CMake adicionando `-mtail-call`.

### Fase 2 — gerador

1. `arm-recomp-core`: trocar os pontos de cauda da seção 5 (commit no submódulo).
2. `src/recompile/emit_function.cpp:398-402`: fall-through.
3. Bump do submódulo no `gbarecomp`.
4. Rodar os testes de codegen (`tests/codegen`, `tests/recompile`). Uma busca
   por asserts sobre o texto emitido (`runtime_dispatch(0x…`, `();`, `return;`)
   **não encontrou nenhum**; confirmar lendo os testes, porque podem existir
   comparações indiretas (hash, golden file) que a busca não pegou.

### Fase 3 — regenerar

1. BIOS: `gba_recompile --bios … --out <pasta de build>`.
2. `pk`: regenerar `output/pk` (inclui recopiar os headers via `tools/cli.py`).
3. Um jogo nativo de referência (MinishCap), se disponível.

### Fase 4 — validação nativa (nada pode mudar)

1. `ctest` completo, incluindo `bios_intro_flawless`.
2. `python oracle/diff_frame.py --scan 1 240 1` → IDENTICAL.
3. Comparar o objdump de um shard antes/depois: o esperado é código idêntico
   (pelo F6), ou diferenças só de layout sem mudança de instruções.
4. Relatório de cobertura: continua igual (misses, interpretados, curados).

### Fase 5 — validação wasm

1. Contar `return_call` nos objetos: deve saltar de 9 para a ordem de dezenas de
   milhares por shard.
2. Node com stack padrão, `GBARECOMP_SELFHEAL_RECOMPILE=0`: 120, 600, 1800 e
   10.800 frames, single-thread e `PROXY_TO_PTHREAD`. Todos `FULLY_STATIC`,
   sem `RangeError`.
3. Build **sem** `-mtail-call` precisa falhar no `#error` (teste da proteção).
4. Medir tamanho do `.wasm` (`-O2`) e comparar com os 44,5 MB atuais.

### Fase 6 — documentação

Atualizar `WEB_WASM_EXPERIMENTS.md` (resultado), `WEB_WASM_PORT.md` (tail calls
como pré-requisito) e as notas de ABI do overlay.

---

## 7. Critérios de aceite

- [ ] Nativo: `ctest` verde, `bios_intro_flawless` verde, oracle IDENTICAL,
      cobertura inalterada.
- [ ] Self-heal nativo funcionando nos dois backends (gcc e tcc).
- [ ] Wasm: ≥ 10.800 frames com stack padrão, single-thread e multithread,
      `FULLY_STATIC`.
- [ ] Build wasm sem `-mtail-call` falha na compilação com mensagem clara.
- [ ] Nenhuma edição manual em `generated/`; submódulo commitado e ponteiro atualizado.

---

## 8. Riscos

| Risco | Mitigação |
|---|---|
| `musttail` recusa algum ponto (assinatura, objeto com destrutor no escopo) | O erro é de compilação, não silencioso; tratar caso a caso na Fase 0/2 |
| Cadeias que passam por `runtime_swi`, `runtime_exception_return` ou pelo bridge do interpretador continuam recursivas | Medir na Fase 5 com o symbol map; ampliar o inventário se aparecerem |
| Versão da ABI do overlay não incrementada → DLL velho em cache carregado | Incremento obrigatório na Fase 1 |
| Suporte de navegador a tail calls | Confirmar a matriz atual antes do lançamento (referência de memória: Chrome 112+, Firefox 121+, Safari 18.2+ — **não verificada**) |
| Repositório em disco externo cria arquivos `._*` (AppleDouble) até dentro de `.git/modules/…/objects/pack`, gerando `error: non-monotonic index` no git do submódulo | Resolver antes de commitar no submódulo (ex.: `dot_clean`), **com confirmação** — não apagar às cegas |

---

## 9. Perguntas para o senior

1. Tudo bem trocar a forma literal por `GBARECOMP_TAIL_CALL(call)` se o tcc
   rejeitar `return f();` em função `void`?
2. Para o dispatch: opção A (global + `void(void)`) é aceitável na ABI, ou ele
   prefere outra?
3. Onde a macro deve morar — no `runtime_arm_types.h` compartilhado do
   `arm-recomp-core` ou em um header novo só do gbarecomp?
4. Incrementar a versão da ABI do overlay agora ou junto de outra mudança?
