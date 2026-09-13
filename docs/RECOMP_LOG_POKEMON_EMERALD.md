# RECOMP LOG — Pokémon Emerald (`roms/pk.gba` → `output/pk`)

**Data:** 2026-09-13
**Objetivo:** gerar um recomp estático de `roms/pk.gba` em `./output/pk`, como
base para uma tentativa posterior de link com WebAssembly.
**Status final:** C gerado (99 274 funções) e **compilando** em
`libgbarecomp_game.a`. Cobertura **NÃO** verificada como FULLY STATIC — ver
seção "Honestidade de cobertura".

Referências cruzadas: `CLAUDE.md` (build loop, dispatch miss rule),
`PRINCIPLES.md` (coverage honesty), `docs/TOML_SCHEMA.md`,
`docs/WEB_WASM_PORT.md`.

---

## 0. Identidade do ROM

| campo | valor |
|---|---|
| título (0xA0) | `POKEMON EMER` |
| game code | `BPEE` (Pokémon Emerald, USA) |
| maker / fixed | `01` / `0x96` |
| version (0xBC) | `0x00` → rev 0 |
| tamanho | `0x01000000` (16 777 216 bytes) |
| sha1 | `f3ae088181bf583e55daf962a92bb46f4f1d07b7` |
| md5 | `605b89b67018abcea91e693a4dd25be3` |

```sh
xxd -s 0xA0 -l 32 roms/pk.gba
shasum -a 1 roms/pk.gba
md5 -q roms/pk.gba
```

---

## 1. Bloqueio: submódulo `external/arm-recomp-core` vazio

`git submodule status` mostrava `-763b922f...` (não inicializado) e
`find external/arm-recomp-core -type f | wc -l` → `0`.

Isso quebra `tools/cli.py::copy_framework()`, que exige
`external/arm-recomp-core/profiles/armv4t_gba/runtime_arm_types.h` (o header
para onde `framework/include/runtime_arm_types.h` aponta, via caminho relativo).

```sh
GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true \
  git submodule update --init external/arm-recomp-core
# → checked out '763b922f4912708d2704e7833f18addfbf8ddf33'  (77 arquivos)
```

> Nota: o git cospe `error: non-monotonic index ... ._pack-*.idx` a cada
> comando. São os arquivos AppleDouble (`._*`) que o macOS cria neste volume
> exFAT sendo confundidos com packs. **É ruído, não falha** — o checkout e o
> `git status` funcionam normalmente.

---

## 2. Primeira tentativa — falhou de duas maneiras

```sh
GBARECOMP_CORE=/Volumes/SSD_1TB/www/fabio/gbarecomp/build/gba_recompile \
  python3 tools/cli.py build --rom roms/pk.gba --output output/pk --force --verbose
```

(`GBARECOMP_CORE` é necessário porque `tools/cli.py::core_path()` só procura
`gba_recompile-core.exe` ou `build/cli-release/core/Release/gba_recompile.exe`
— caminhos de release Windows. Nesta árvore o binário é `build/gba_recompile`.)

### 2a. Só 8 funções descobertas

```
==> discovered 8 functions (arm=8 thumb=0 indirect=6 undefined=2 branch_targets=7)
```

**Causa raiz:** `tools/gba_recompile/main.cpp:95` usa
`uint32_t entry = 0x080000C0u` como default — a convenção GBA de "código começa
logo após o header de 192 bytes". **Neste ROM `0x080000C0` é só zeros.**

```
08000000: EA00007F   ← b (0x08000000 + 8 + 0x7F*4) = 0x08000204
080000C0: 00000000   ← zeros
08000204: E3A00012   ← mov r0, #0x12      (modo IRQ)
08000208: E129F000   ← msr CPSR_fc, r0
0800020C: E59FD028   ← ldr sp, [pc, #0x28]
```

O crt0 real está em **`0x08000204`**. Com o entry errado o finder caía num
punhado de stubs ARM e parava.

### 2b. `TypeError` no scaffolding

```
File "tools/cli.py", line 184, in write_project
  (output / "CMakeLists.txt").write_text(cmake, encoding="utf-8", newline="\n")
TypeError: write_text() got an unexpected keyword argument 'newline'
```

`Path.write_text()` só ganhou o kwarg `newline` no Python **3.10**. O Python
desta máquina é o 3.9.6 que vem com o macOS.

---

## 3. Alterações necessárias

### 3a. `tools/cli.py` — compatibilidade com Python 3.9

```diff
-    (output / "CMakeLists.txt").write_text(cmake, encoding="utf-8", newline="\n")
-    (output / "build.ps1").write_text(build_ps1, encoding="utf-8", newline="\n")
-    (output / "build.sh").write_text(build_sh, encoding="utf-8", newline="\n")
-    (output / "README.md").write_text(readme, encoding="utf-8", newline="\n")
-    (output / "gbarecomp-project.json").write_text(
-        json.dumps(metadata, indent=2) + "\n", encoding="utf-8", newline="\n"
-    )
+    # Path.write_text() only grew a `newline` keyword in 3.10; open() has
+    # always had it, and the CLI still has to run on the 3.9 that ships with
+    # macOS.
+    for name, text in (
+        ("CMakeLists.txt", cmake),
+        ("build.ps1", build_ps1),
+        ("build.sh", build_sh),
+        ("README.md", readme),
+        ("gbarecomp-project.json", json.dumps(metadata, indent=2) + "\n"),
+    ):
+        with open(output / name, "w", encoding="utf-8", newline="\n") as handle:
+            handle.write(text)
```

`open(..., newline="\n")` tem o mesmo efeito e existe desde sempre.

### 3b. `output/pk/game.toml` — config por jogo, escrita à mão

Conforme `CLAUDE.md`: config de jogo é **revisada por humano**, nunca
auto-escrita.

```toml
[program]
name         = "Pokemon Emerald (USA)"
id           = "pk_bpee"
load_address = 0x08000000
size         = 0x01000000
entry_pc     = 0x08000204

aot_scan_start = 0x08000204
aot_scan_end   = 0x081DD000

[identity]
sha1 = "f3ae088181bf583e55daf962a92bb46f4f1d07b7"
md5  = "605b89b67018abcea91e693a4dd25be3"
```

#### Como os limites do `aot_scan` foram determinados

Não foram chutados. Medi a densidade de prólogos THUMB `push {..., lr}`
(halfword `0xB5xx`) por bloco:

```python
d = open('roms/pk.gba','rb').read()
for base in range(0, len(d), 0x10000):
    chunk = d[base:base+0x10000]
    t = sum(1 for i in range(0, len(chunk)-1, 2) if chunk[i+1] == 0xB5)
    print(f"{0x08000000+base:08X}:{t:5d}")
```

Resultado (por 64 KiB):

| faixa | densidade | leitura |
|---|---|---|
| `0x08000000`–`0x081DBFFF` | 300 – 1100 | código real |
| `0x081DC000` | 5 | fim do `.text` |
| `0x081DD000` em diante | 0 | dados |
| `0x086B0000`–`0x088F0000` | 24 – 174 | ruído de gráficos comprimidos, **não** código |

Refinando em blocos de 4 KiB, a queda fica clara entre `0x081DB000` (37) e
`0x081DD000` (0). Daí `aot_scan_end = 0x081DD000`.

`docs/TOML_SCHEMA.md` é explícito: *"Keep compressed graphics and other assets
outside this range."* — por isso a banda `0x086B0000+` fica de fora, apesar da
densidade não-zero.

---

## 4. Geração

```sh
./build/gba_recompile --rom roms/pk.gba \
                      --config output/pk/game.toml \
                      --out output/pk/generated > output/pk/recompile.log 2>&1
```

Depois, para gerar o scaffolding (`CMakeLists.txt`, `build.sh`, `build.ps1`,
`README.md`, `gbarecomp-project.json`, `framework/include/`):

```sh
GBARECOMP_CORE=/Volumes/SSD_1TB/www/fabio/gbarecomp/build/gba_recompile \
  python3 tools/cli.py build --rom roms/pk.gba --output output/pk \
                             --config output/pk/game.toml --force
```

### Sumário de descoberta (`output/pk/recompile.log`)

```
identity sha1:         f3ae088181bf583e55daf962a92bb46f4f1d07b7 (verified)
AOT scan range:        [0x08000204,0x081DD000)
static resume all:     disabled
==> discovered 99274 functions (arm=110 thumb=99164 indirect=46737
                                undefined=2291 branch_targets=498222)
  discovered_by_walk:    99273
  redundant_manual:      1
  auto_jump_tables:      565  (9025 targets)
  jt_confirm_events:     814  (568 distinct: emitted 565, rejected 3 unsized)
  literal_pool_seeds:    13079 kept / 138098 PC-rel literals
  aot_scan_seeds:        3113 table prologues + 237 address-taken leaves
                         de 158 pointer tables
  TOTAL emitted:         99274
==> codegen shards: 64 (adaptive)
```

**Aviso registrado no log** (topo de `recompile.log`):

```
WARNING: 10 control-flow entries into an auto-detected jump_table
(mis-modeled switch; bytes kept as data, residual branches self-heal at runtime).
  [0x0807BC1C,0x0807C04C) auto jump_table <- 0x0807BDFA via branch in fn 0x0807C1DC
```

---

## 5. Verificação de build

Teste isolado de um shard primeiro:

```sh
cd output/pk
clang++ -std=c++20 -O1 -c -Iframework/include -Igenerated \
        generated/recompiled_000.cpp -o /tmp/s000.o
# exit 0 — 7.2 MB de fonte → 1.77 MB de objeto em 2.4 s
```

Build completo:

```sh
cd output/pk && chmod +x build.sh && sh build.sh > build_lib.log 2>&1
# exit 0
```

| artefato | tamanho |
|---|---|
| `output/pk/generated/` (64 shards + dispatch + symbol_map) | 468 MB |
| `output/pk/build/` | 289 MB |
| `output/pk/build/libgbarecomp_game.a` | 133 MB |
| símbolos `gf_` exportados (`nm ... \| grep -c " T _gf_"`) | **99 274** |

Zero erros. Um único warning, benigno:

```
ranlib: warning: 'libgbarecomp_game.a(symbol_map.cpp.o)' has no symbols
```

### Sobre esse warning — gotcha real de link

`nm -m` confirma que `symbol_map.cpp.o` **não define nenhum símbolo externo**:

```
__GLOBAL__sub_I_symbol_map.cpp   non-external
__ZL13kGbaSymbolMap              non-external
_gba_symbol_register_cart        (undefined) external
```

O linker só puxa um membro de um `.a` se ele resolver algum símbolo indefinido.
Como este não define nada, **ele nunca é linkado a partir do arquivo** → o
inicializador estático não roda → os 99 274 nomes de função não se registram no
resolver de `src/armv4t/symbol_lookup.cpp`.

Só afeta *nomes* em dumps de debug, não a correção da execução. Para corrigir:
`-Wl,-force_load` (Mach-O) / `--whole-archive` (ELF), ou compilar
`symbol_map.cpp` direto no executável em vez de na lib.

---

## 6. Honestidade de cobertura

Conforme `PRINCIPLES.md` — *"Coverage honesty is load-bearing"*:

> **Este build NÃO pode ser chamado de FULLY STATIC.**

O que está provado:
- 99 274 funções descobertas estaticamente;
- identidade do ROM verificada por sha1 pelo próprio recompilador;
- todo o C gerado compila e linka numa lib estática.

O que **não** está provado:
- cobertura real em execução. Isso exige rodar o jogo e ler o miss-list
  (`recomp_master_misses.toml.frag`) + o banner de coverage, e isso precisa de
  um **projeto de jogo completo** (janela, runtime, saves), não da lib estática
  sozinha;
- 46 737 sites de controle indireto e 2 291 funções com opcode indefinido no
  corpo permanecem não exercitados;
- os 10 branches entrando em jump table auto-detectada (seção 4) são resíduo
  previsto para self-heal em runtime.

Próximo passo do loop do `CLAUDE.md`: rodar → coletar
`recomp_seed_proposals.toml` → **revisar à mão** → merge em `game.toml` →
regerar → repetir até o banner dizer FULLY STATIC.

---

## 7. Implicações para o port WebAssembly

Ver `docs/WEB_WASM_PORT.md` para o quadro completo. Dois pontos que este recomp
específico levanta:

1. **`static_resume_all` está `disabled`.** A seção 3 do WEB_WASM_PORT é dura:
   não existe `dlopen`/`system("gcc")` no navegador, então um dispatch miss
   **não se auto-cura — mata a sessão**. Um build web precisa de
   `static_resume_all = true` no `game.toml`. Não foi ligado aqui porque
   adiciona uma entrada de dispatch/resume por instrução alinhada e inflaria
   bastante os 468 MB atuais. É uma decisão a tomar, não um esquecimento.

2. **`emcc` não está instalado nesta máquina** (`which emcc` → não encontrado),
   então o passo 1 da "Ordem sugerida" do WEB_WASM_PORT — medir o tamanho do
   wasm com `emcc -Os -c` num shard — não pôde ser executado. O C gerado já
   está pronto para essa medição, que é o teste que pode matar a ideia antes de
   qualquer outro esforço.

---

## 8. Inventário de mudanças

### No repositório (rastreado pelo git)

| arquivo | mudança |
|---|---|
| `tools/cli.py` | fix de compat Python 3.9 (`write_text(newline=)` → `open(newline=)`) |
| `external/arm-recomp-core` | submódulo inicializado em `763b922f` |

### Novos, não rastreados

| caminho | o que é |
|---|---|
| `output/pk/game.toml` | config por jogo, escrita à mão, revisável |
| `output/pk/generated/` | 468 MB de C++ gerado — **nunca editar** |
| `output/pk/{CMakeLists.txt,build.sh,build.ps1,README.md,gbarecomp-project.json}` | scaffolding do `cli.py` |
| `output/pk/framework/include/` | headers do runtime copiados |
| `output/pk/external/arm-recomp-core/profiles/armv4t_gba/` | `runtime_arm_types.h` copiado |
| `output/pk/recompile.log` | log completo de descoberta |
| `output/pk/build_lib.log` | log de compilação |
| `output/pk/build/` | 289 MB de artefatos de build |

> `output/` **não está no `.gitignore`** — são ~757 MB não rastreados. Vale
> ignorar se não for para commitar.

---

## 9. Reprodução do zero

```sh
cd /Volumes/SSD_1TB/www/fabio/gbarecomp

# 1. submódulo
GIT_TERMINAL_PROMPT=0 git submodule update --init external/arm-recomp-core

# 2. o core já estava compilado em build/gba_recompile; se não estiver:
#    cmake -S . -B build && cmake --build build --target gba_recompile

# 3. gerar (game.toml já versionado em output/pk/)
GBARECOMP_CORE="$PWD/build/gba_recompile" \
  python3 tools/cli.py build --rom roms/pk.gba --output output/pk \
                             --config output/pk/game.toml --force

# 4. compilar o C gerado
cd output/pk && sh build.sh
```
