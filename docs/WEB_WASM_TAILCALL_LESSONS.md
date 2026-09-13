# WEB_WASM_TAILCALL_LESSONS — erros cometidos e aprendizados

**Data:** 2026-09-13
**Sessão:** investigação e protótipo das tail calls garantidas para wasm
(resultado em `docs/WEB_WASM_TAILCALL_IMPLEMENTATION.md`).
**Objetivo deste documento:** registrar, sem suavizar, os erros que aconteceram durante a
investigação, o que cada um quase causou e como evitar. Complementa as armadilhas de
`WEB_WASM_EXPERIMENTS.md` §8 e `WEB_WASM_TAILCALL_IMPLEMENTATION.md` §10.

---

## 1. Resumo

Nenhum erro chegou ao resultado final, mas **quatro deles produziram "sucesso" falso** na
tela (seções 2.1, 2.2, 2.5 e 2.9). Só foram pegos porque os números não batiam ou porque o
teste foi refeito. O padrão comum: **um comando que falha em silêncio e um verificador que
aceita saída vazia como "igual"**.

As três regras que teriam evitado quase tudo:

1. Rodar scripts de validação em **bash com `set -euo pipefail`**, não no zsh interativo.
2. **Nunca declarar "idêntico" sem conferir que os dois lados existem e não estão vazios**
   (`test -s`).
3. **Antes de atribuir qualquer falha à mudança, rodar o mesmo cenário no baseline nativo.**

---

## 2. Erros cometidos

### 2.1 Word splitting do zsh — de novo (a armadilha já estava documentada)

- **O que aconteceu:** `F="-std=c++20 -O3 -DNDEBUG -c"; c++ $F …`. O zsh passou as flags como
  **um argumento só** → `error: invalid value 'c++20 -O3 -DNDEBUG -c'`.
- **Pior:** na segunda tentativa, com `${=F}`, o `-c` ainda não chegou ao compilador (a causa
  exata não foi confirmada) e o clang tentou **linkar** o shard, cuspindo milhares de
  `Undefined symbols`.
- **Agravante:** `WEB_WASM_EXPERIMENTS.md` §8.3 já avisava exatamente isso.
- **Como evitar:**
  - Scripts de build/validação sempre em `bash` (arquivo `.sh` ou `bash -c '…'`).
  - Quando precisar de flags reutilizáveis no zsh, preferir escrever as flags literais no
    comando ou usar array (`flags=(-O3 -c); c++ "${flags[@]}"`).
  - Ler a primeira linha de erro antes de olhar o resto: "invalid value '… …'" com espaços
    dentro das aspas é sempre word splitting.

### 2.2 "Identical" falso: `cmp` de duas saídas vazias

Aconteceu **duas vezes**:

- **Overlay:** os `.so` não foram gerados (erro de compilação), o `objdump` escreveu o erro no
  stderr, o stdout ficou vazio dos dois lados e
  `cmp <(objdump … new.so) <(objdump … old.so) && echo identical` imprimiu
  **"c++ overlay disassembly identical"** e **"tcc overlay disassembly identical"**.
- **Shard nativo:** os `.o` não existiam (erro 2.1), `wc -l` deu `0` e mesmo assim saiu
  **"native shard 000 -O3 disassembly identical"**.
- **Como evitar:**
  - Gravar a disassembly em arquivo e exigir `test -s arquivo` antes do `cmp`.
  - `set -e` para o script parar no primeiro compilador que falhar.
  - Imprimir junto com o veredito o tamanho do que foi comparado
    (`IDENTICAL (266975 linhas)`); "0 linhas" denuncia na hora.

### 2.3 `echo ======` no zsh derrubou o ctest do baseline

- **O que aconteceu:** `(cd proto && ctest …); echo ======; (cd base && ctest …)`.
  No zsh, `=palavra` é *equals expansion* (procura um comando chamado `=====`) →
  `(eval):1: ===== not found`, e a parte do baseline não rodou.
- **Como evitar:** separadores sempre entre aspas (`echo '======'`) ou usar `---`.

### 2.4 Glob sem aspas no `grep --include`

- **O que aconteceu:** `grep -rn … --include=*.cpp src` no zsh → `no matches found:
  --include=*.cpp` e o grep nem executou.
- **Como evitar:** `--include='*.cpp'` sempre entre aspas. O mesmo vale para `rm -f *.o`
  numa pasta vazia (zsh aborta o comando com `no matches found`).

### 2.5 `diff-exit=0` que era do `head`, não do `diff`

- **O que aconteceu:** `diff -rq A B | head -5; echo "diff-exit=$?"` imprimiu `0`, mas o `$?`
  era do `head`. As 5 linhas mostradas eram só arquivos `._*`, então o resultado real era
  desconhecido.
- **Como evitar:** `set -o pipefail`, ou não usar pipe quando o código de saída importa;
  para diretórios em volume exFAT, `diff -rq -x '._*'`.

### 2.6 Heredoc sem aspas executou o conteúdo

- **O que aconteceu:** um script Python passado por `python3 - <<EOF` continha comentários com
  crases (`` `call; return` ``). O shell executou como substituição de comando
  (`command not found: call`), o texto chegou corrompido ao Python, uma asserção falhou e a
  edição do `gen_codegen_tests.cpp` não foi aplicada.
- **Como evitar:** heredoc **sempre** `<<'EOF'` (com aspas) quando o corpo contém código.
  Passar valores de shell por `sys.argv`, não por interpolação dentro do heredoc.

### 2.7 `cd` sem subshell mudou o diretório da sessão

- **O que aconteceu:** `cd external/arm-recomp-core && git status` num comando isolado deixou a
  sessão inteira dentro do submódulo; os comandos seguintes com caminho relativo passariam a
  apontar para o lugar errado.
- **Como evitar:** caminhos absolutos, `git -C <dir>` ou `(cd dir && …)` em subshell.

### 2.8 Comandos que não existem no macOS

- `timeout` não existe no macOS (é GNU coreutils) → o `git clone` do tinycc não rodou.
- **Como evitar:** não assumir GNU. Alternativas: rodar em background, `gtimeout` (brew
  coreutils) ou deixar o timeout para a ferramenta que executa.

### 2.9 Fixture de teste que não representava o produtor real

- **O que aconteceu (overlay):** para testar o self-heal com tcc, o script escolheu uma função
  do BIOS **com alias de resume**. Ela usa `g_runtime_resume_pc`, que o shim do overlay não
  declara → erro de compilação sem relação com a mudança. Overlays reais nunca têm alias
  (o `overlay_emit.cpp` roda o finder com uma semente só).
- **O que aconteceu (SWI sintético):** o SWI de teste foi inserido como
  `if (…) { GBARECOMP_TAIL_SWI(…); }` numa linha só, **violando a regra que o próprio
  desenho exige** (macro em linha própria). O regex do "texto antigo" não casou.
- **Como evitar:** antes de montar fixture, ler o produtor real (`overlay_emit.cpp`) e copiar
  suas restrições (sem alias, `names` vazio → sem chamadas diretas por nome). Fixture
  sintética também obedece às regras do código gerado.

### 2.10 Teste isolado mal construído (C no emcc)

- **O que aconteceu:** o arquivo C foi derivado do C++ com `sed` e o `sed` apagou chaves
  (`function definition is not allowed here`). Na versão refeita, `return_call=1` quando o
  esperado parecia `2`: a segunda transferência vinha depois de uma transferência
  incondicional, logo era código morto e foi eliminada.
- **Como evitar:** escrever o teste C à mão (é curto) e colocar cada site de cauda atrás de uma
  condição, para que todos sejam alcançáveis e a contagem seja previsível.

### 2.11 Assumir formato de ferramenta sem olhar a saída crua

- **O que aconteceu:** duas rodadas de `awk` sobre o `objdump` do `runtime_arm.cpp.o` nativo
  voltaram vazias, porque o rótulo no Mach-O é `0000000000001590 <_runtime_dispatch>:` e não
  `_runtime_dispatch:`.
- **Como evitar:** antes de filtrar, `head`/`grep -n nome` na saída crua para ver o formato.

### 2.12 Build nativo sem BIOS recompilado

- **O que aconteceu:** as cópias `base/` e `proto/` foram configuradas com o
  `GBARECOMP_GENERATED_BIOS_DIR` padrão (`src/runtime/generated_bios`), que no repositório só tem
  o stub. O runtime nativo resultante teria só o placeholder de BIOS. Foi percebido antes de
  rodar e reconfigurado com o BIOS gerado.
- **Como evitar:** depois de todo configure, procurar `BIOS recompiled output present — linking`.
  Se aparecer `absent — placeholder dispatch only`, o executável não serve para rodar jogo.

### 2.13 Quase atribuir à mudança falhas que já existiam

Dois quase-erros de diagnóstico, evitados por A/B:

- **`NOT_STATIC` em 1.800 frames:** o wasm novo passou a rodar mais tempo e mostrou 36 misses.
  Parecia regressão. O log do binário **antigo** já tinha `missing static coverage detected`
  antes do estouro, e o nativo antigo deu exatamente os mesmos 36 misses e as mesmas
  38.016.147 instruções interpretadas.
- **Aborto com input replay:** o wasm novo abortou em
  `SELF-HEAL bridge for 0x080008C8 exceeded 200000000 instructions`. O nativo antigo aborta
  igual, no mesmo ponto.
- **Aprendizado:** uma mudança que faz o programa **ir mais longe** expõe bugs que antes
  estavam escondidos atrás do crash. Sem baseline nativo no mesmo cenário, a conclusão teria
  sido errada. Isso é a regra "earliest divergence" do `CLAUDE.md` aplicada ao método.

### 2.14 Saída gigante no terminal

- **O que aconteceu:** `grep` num log de erro do Emscripten trouxe a linha do `.js` minificado
  inteira (204 KB), porque o node imprime a linha de código onde a exceção passou.
- **Como evitar:** filtrar logs de node com `awk 'length($0) < 400'` antes do `grep`/`tail`.

### 2.15 O plano foi escrito com defeitos e só foi corrigido na revisão

- **O que aconteceu:** a primeira versão do `WEB_WASM_TAILCALL_IMPLEMENTATION.md` tinha:
  um trecho de rascunho confuso na V3 (bloco inútil com `|| true`), um bloco na V8 que usava
  `main.cpp` e `$INCS` antes de defini-los e precisava rodar **antes** das edições, e `$TCC`
  sem definição na V4. Foi corrigido antes da entrega.
- **Limite honesto que continua valendo:**
  - Os **diffs** do plano foram verificados com `patch --dry-run -p1` contra o repo (todos OK).
  - Os **blocos de shell** das seções T0 e V1–V8 foram **adaptados** dos comandos realmente
    executados, mas **não foram executados literalmente, de ponta a ponta, na forma escrita**.
  - O bloco `-mtail-call` do `CMakeLists.txt` foi testado logo após `set(GBARECOMP_SDL2_OK FALSE)`;
    o plano recomenda colocá-lo após o bloco `if(MSVC)`. Ambos vêm antes de qualquer target,
    mas a posição recomendada não foi compilada.
- **Como evitar:** o primeiro agente que executar o plano deve rodar T0 e V1–V8 exatamente como
  escritos e corrigir o documento no mesmo commit se algum comando não funcionar. Em planos
  futuros, gerar os blocos de comando a partir de um script que foi de fato executado.

### 2.16 Informação externa imprecisa

- **O que aconteceu:** a busca sobre suporte de navegador a tail calls wasm confirmou só
  "Baseline Newly available desde dez/2024". As versões mínimas (Chrome 112, Firefox 121,
  Safari 18.2) vieram de memória.
- **Como evitar:** marcar como "a confirmar" (foi feito) e checar a tabela oficial em
  webassembly.org/features antes de publicar requisito de navegador.

---

## 3. Aprendizados técnicos (o que funcionou e vale reutilizar)

### 3.1 Medir o que o nativo faz antes de desenhar a correção para outro alvo

Classificar as relocações `BRANCH26` do objeto arm64 por instrução (`b` × `bl`) deu a lista
exata de destinos que o nativo transforma em salto. O desenho do wasm virou "reproduzir esse
conjunto", em vez de adivinhar. Script usado:

```bash
for o in recompiled_*.o; do objdump -dr --no-show-raw-insn "$o"; done | awk '
/^[[:space:]]*[0-9a-f]+:[[:space:]]+(b|bl)[[:space:]]/ {m=$2; next}
/ARM64_RELOC_BRANCH26/ {sym=$NF; if (sym ~ /^_gf_/) sym="_gf_*"; cnt[m" "sym]++; next}
END {for (k in cnt) print cnt[k], k}' | sort -k3 -k2
```

### 3.2 Provar "nativo inalterado" por texto, não por teste de jogo

Expandir as macros novas de volta para o texto antigo e comparar **byte a byte** com a saída do
gerador antigo (`unmacro.py`, na V2 do plano) prova equivalência para o corpus inteiro em
segundos (168.341 sites no `pk`). Teste de jogo só cobre o que o jogo executa.

### 3.3 Macro com expansão token-idêntica no nativo

`do { … } while (0)` é o hábito seguro para macros, mas mudou o objeto nativo em `-O0`
(medido). A expansão "nua" (`f(); return`) mantém o nativo idêntico em qualquer nível de
otimização e em qualquer compilador (gcc, tcc, MSVC). O custo, uma regra de uso, é pago com um
teste automático (T7 do plano).

### 3.4 Particularidades do `musttail` no Emscripten 6.0.9

- Sem `-mtail-call` o atributo é **ignorado com warning**: proteger com
  `#if defined(__EMSCRIPTEN__) && !defined(__wasm_tail_call__) #error`.
- `__wasm_tail_call__` só é definido com `-mtail-call`.
- Assinaturas precisam ser idênticas (`void(void)` → `void(uint32_t)` é rejeitado). Passar o
  argumento por global resolve.
- `__attribute__((musttail))` funciona em C e em C++; `[[clang::musttail]]` só em C++.
- Chamada indireta (`return entry->fn();`) vira `return_call_indirect` sem problema.
- Função com vários `return` perde a tail call **sem** `musttail`, mas não **com** ele.

### 3.5 Medir margem reduzindo a pilha, não aumentando

`node --stack-size=128` com 10.800 frames passando mostra margem com segurança. Aumentar
`--stack-size` acima do limite da thread do SO pode derrubar o node e não prova nada quando a
profundidade cresce com o tempo.

### 3.6 Mapear o stack trace wasm antes de concluir

`--emit-symbol-map` + o `.symbols` transformaram `wasm-function[27781]` em
`gf_tfunc_082E18B4` e mostraram a recursão mútua real
(`gf_tfunc_082E18B4 → runtime_dispatch → gf_tfunc_082E18B8 → …`).

### 3.7 Protótipo fora do repositório

Copiar o código com `rsync --exclude '._*' --exclude .git` para uma pasta temporária e aplicar os
diffs lá permitiu construir baseline e protótipo lado a lado, rodar ctest dos dois e comparar
tudo sem tocar no repo nem no `.git` do submódulo (que tem arquivos `._*`).

### 3.8 Sinais que não devem ser usados como critério

- `cycles=62191750` saiu igual em 1.800 e 10.800 frames em todos os binários (nativo e wasm).
  Não foi investigado; não usar esse campo como evidência de progresso até entender o contador.
- `self_heal_coverage=NOT_STATIC` no `pk` não é regressão: é o estado atual da cobertura desse
  jogo (seção 2.13).

---

## 4. Checklist antes de declarar qualquer resultado

- [ ] O script rodou em bash com `set -euo pipefail`?
- [ ] Os arquivos comparados existem e não estão vazios (`test -s`)?
- [ ] O veredito mostra o tamanho do que foi comparado (linhas/bytes/contagem)?
- [ ] O código de saída verificado é do comando certo (sem pipe no meio)?
- [ ] Heredocs com código estão com `<<'EOF'`?
- [ ] O configure mostrou `BIOS recompiled output present` e SDL2 encontrado quando necessário?
- [ ] O mesmo cenário foi rodado no **baseline nativo** antes de culpar a mudança?
- [ ] A fixture de teste respeita as restrições do produtor real?
- [ ] Cada run rodou numa pasta descartável própria?
- [ ] Números "de memória" estão marcados como "a confirmar"?
- [ ] Comandos colocados num documento foram executados na forma exata em que foram escritos?
