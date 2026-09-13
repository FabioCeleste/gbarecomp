# Plano de implementação do host web: canvas, apresentação, entrada e áudio

Data: 2026-09-13. Estado: **backend de produção implementado (`GBARECOMP_WEB_HOST`); validação dos gates §14/§15 pendente**. As seções abaixo mantêm o texto do plano original como contrato; §21 resume o que foi entregue.

Este documento é autossuficiente para implementar a correção. Define o problema, a arquitetura escolhida, os contratos entre threads, as alterações por arquivo, a ordem de trabalho e os testes. Não exige ler o diário anterior nem reproduzir decisões de uma conversa. Os caminhos de código são relativos à raiz de `gbarecomp`, salvo indicação explícita.

## 1. Decisão e escopo

**Manter o jogo e seu loop bloqueante na pthread; manter o canvas e o WebGL na thread principal do navegador.** O jogo publica RGB888 em um buffer triplo compartilhado. Um `requestAnimationFrame` da página consome o frame mais recente e faz upload para uma textura WebGL. Entrada percorre o sentido inverso, por estado e comandos atômicos. Áudio usa um ring SPSC separado, consumido por AudioWorklet.

A correção definitiva não força `SDL_RENDER_DRIVER=software`, não usa `SDL_AUDIODRIVER=dummy` e não depende de editar o cache do emsdk. O SDL continua sendo o backend nativo. No build web, outro arquivo implementa a mesma interface `HostWindow`.

A recomendação inicial de criar OffscreenCanvas **no próprio worker do jogo** foi testada e rejeitada para o loop atual: o contexto é criado e as chamadas GL executam, mas a imagem só aparece quando o worker devolve controle ao event loop. `emscripten_webgl_commit_frame()` retornou sucesso sem resolver isso. Uma thread de renderização independente poderia usar OffscreenCanvas corretamente, mas adicionaria um worker e outro ciclo de vida sem necessidade demonstrada para este framebuffer.

O objetivo é corrigir o host do navegador, preservando BIOS, PPU, CPU, dispatch, tail calls, frames de emulação e dados de áudio produzidos pelo núcleo. Cobertura estática da ROM e persistência dos saves são entregas separadas: devem continuar visíveis, mas não são corrigidas alterando o canvas.

### Definição de pronto

- Start carrega o jogo e apresenta imagens sucessivas durante a execução, com WebGL e áudio habilitável por gesto real.
- Nenhum acesso ao canvas transferido, `GLctx` indefinido ou `SDL2.audioContext` indefinido.
- Framebuffer entregue, estado final e cobertura equivalentes ao baseline sob a mesma entrada e ponto de parada.
- Teclado, blur, resize, filtros, áudio, pausa, término e perda/restauração de contexto têm comportamento definido e testado.
- O jogo não espera pelo renderer a cada frame; filas são limitadas e seus descartes são contados.
- A página distingue frames emulados, publicados e submetidos ao WebGL. Não chama todos esses contadores de “frames apresentados”.
- Limitações de navegador/capacidade são informadas. Falha de WebGL não vira software silenciosamente; áudio suspenso não é anunciado como funcionando.
- Nativo continua compilando e seus testes apropriados passam.

## 2. Base analisada e isolamento dos experimentos

Base do repositório: `f8467d3` (`feat/web-wasm-tailcall`). Submódulo `external/arm-recomp-core`: `a8802bb6681f102abbd97c02ac370a8e6b537012`.

Worktree criada:

```
/Volumes/SSD_1TB/www/fabio/gbarecomp-web-canvas
branch: investigation/web-canvas
laboratório: lab/web-canvas/
```

As mudanças experimentais estão no laboratório dessa worktree. A árvore original não recebeu substituição de backend. A cópia deste plano em `docs/` é o artefato a implementar, não uma declaração de que o protótipo já pode ser integrado.

Os testes integrados reutilizaram, somente como entradas de link, os archives wasm existentes da árvore original: runtime/BIOS e jogo PK. Compilaram um novo objeto com os símbolos `HostWindow`, colocado antes dos archives no link. Assim o linker não extraiu `host_window.cpp.o` do archive. O bundle experimental linkou **sem `-sUSE_SDL=2` e sem flags OffscreenCanvas**. Não houve alteração de código gerado, ROM, BIOS, TOML ou cache SDL do SDK.

Isso prova a viabilidade da substituição na fronteira do host. Não substitui o clean build por CMake que a implementação deverá fazer.

Ambiente medido: macOS Apple Silicon; Chrome 152.0.7977.83 headless com GPU real identificada como `ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)`; também houve testes OffscreenCanvas via SwiftShader. Emscripten instalado: 6.0.9; SDL do port: release 2.32.10. O servidor de laboratório usou COOP `same-origin` e COEP `require-corp` em `127.0.0.1:18081`.

ROM PK: Pokémon Emerald USA, código BPEE, SHA-1 `f3ae088181bf583e55daf962a92bb46f4f1d07b7`. BIOS: SHA-1 `300c20df6731a33952ded8c436f7f186d25d3492`. Usar dumps locais; não incluir esses binários no patch.

## 3. Causa raiz: rastreamento do caminho atual

### 3.1 Inicialização e propriedade do canvas

`packaging/web/index.html` cria `Module.canvas` e carrega `game.js` depois do Start. O `preRun` popula MEMFS com ROM/BIOS. `packaging/web/build_web.sh` atualmente liga:

```
-pthread -sPROXY_TO_PTHREAD
-sOFFSCREENCANVAS_SUPPORT -sOFFSCREEN_FRAMEBUFFER
```

No SDK instalado, `OFFSCREENCANVASES_TO_PTHREAD` tem default `#canvas`. O canvas é transferido para a pthread de `main()`. O DOM fica com um placeholder; a página não pode voltar a criar um contexto nele.

### 3.2 SDL software: primeiro acesso inválido

`src/runtime/host_window.cpp`, `HostWindow::open()`, tenta renderer acelerado e então software. O fallback de acelerado para software não registra a primeira falha quando vsync não foi solicitado.

No port instalado, `SDL_emscriptenframebuffer.c`, `Emscripten_UpdateWindowFramebuffer()`, usa `MAIN_THREAD_EM_ASM` e chama `Browser.createContext(Module['canvas'], false, true)`. O acesso acontece na página, que já perdeu o controle do canvas. Esse é o primeiro erro de propriedade; alterar pixels da PPU ou CSS não o corrige.

### 3.3 SDL acelerado: contexto na thread errada

`SDL_emscriptenopengles.c` utiliza EGL. No `src/lib/libegl.js` instalado, `eglCreateContext` e `eglMakeCurrent` são proxied para a thread principal. O caminho testado deixa o worker executando chamadas de renderer sem o contexto GL local esperado. O erro observado na sessão anterior foi `createShader` de `undefined`.

Não generalizar isso como “SDL2 nunca suporta pthreads”. É uma incompatibilidade dos caminhos usados por **este port, esta versão e este modelo de execução**. Corrigir/migrar a dependência também seria possível, mas exigiria manter e validar esse port.

### 3.4 O obstáculo adicional: present-in-place

`src/runtime/runtime.cpp` instala `runtime_set_frame_present_hook`. O hook é chamado de dentro de `runtime_should_yield`, durante execução recompilada. Ele recebe o framebuffer latched ou chama `ppu.render`, apresenta, drena áudio, aplica entrada e chama `FramePacer`.

O código recompilado pode permanecer dentro de um único `step_once()` durante toda a sessão. Isso é intencional: evita desenrolar a pilha de execução e redispatchar um PC interior a cada VBlank.

`src/runtime/host_platform.cpp`, `FramePacer::wait_for_next_frame()`, usa `sleep_until`/`yield`. Isso espera tempo de host, **não devolve o callback JavaScript ao event loop do worker**.

Por isso criar WebGL no worker do jogo não basta. No SDK 6.0.9, `libhtml5_webgl.js`, `emscripten_webgl_do_commit_frame()`, contém um caminho que apenas retorna sucesso: o antigo `GLctx.commit()` não existe nos navegadores atuais testados. `glFlush`, sleep de pthread e sucesso de `commit_frame` não comprovam apresentação visível.

Não trocar o loop por `emscripten_set_main_loop` sem projetar a continuação do guest. Isso mexeria justamente na fronteira que as tail calls e present-in-place estabilizaram.

### 3.5 Áudio é uma falha independente

No port SDL instalado, `SDL_emscriptenaudio.c:273` lê `SDL2.audioContext.sampleRate` via `EM_ASM_INT`, enquanto criação/acessos relacionados usam a thread principal. O worker não possui o objeto esperado.

No projeto, `HostWindow::open()` abre áudio junto com vídeo. Assim um canvas corrigido ainda pode falhar ao abrir áudio. O novo backend precisa substituir ambos os caminhos para o Start padrão funcionar sem `dummy`.

### 3.6 Recursos do host que não podem desaparecer acidentalmente

O backend SDL também implementa cor (`ColorLut`), layout, sharp scaling, configuração de teclas, fullscreen, volume, sensores, gamepad, ferramentas Assist e, opcionalmente, ImGui. A interface `HostWindow` tem mais métodos do que `open/present/close`.

Há duas sutilezas relevantes no chamador:

- `HostWindow::push_audio_samples` diz 32.768 kHz no comentário do header, mas o SDL/RAB configura fonte de 65.536 Hz. `GbaAudio::sample_rate()` depende de SOUNDBIAS. Não copiar o comentário como contrato verdadeiro de áudio.
- A pausa é tratada por um `while (host_paused...)` no loop externo; o hook de present-in-place apenas alterna o flag. Uma sessão que permanece dentro do guest pode não chegar a esse `while`. A implementação web deve testar a pausa e tratar a espera na fronteira interna sem perder a continuação do guest.

Esses achados vêm de inspeção de código; o defeito específico de pausa não foi validado como regressão funcional nesta investigação.

## 4. Experimentos e evidências

Os experimentos de cor são independentes da ROM. Seu oráculo é o padrão RGB conhecido e a imagem capturada pelo compositor; não medem correção da emulação. Os testes do jogo comparam saídas existentes do runtime sob a mesma entrada, no VBlank final solicitado. Nenhum novo atalho de BIOS ou comportamento de guest foi introduzido.

| Experimento | Resultado | O que prova |
|---|---|---|
| OffscreenCanvas no worker, loop bloqueante, swap implícito | Contexto válido e frames avançando; screenshots brancas durante o loop; cor aparece ao retornar | Criar contexto correto não resolve o loop atual |
| Mesmo loop com swap explícito + `commit_frame()` | Retorno 0/sucesso; `GLctx.commit` ausente; mesmo bloqueio visual | Sucesso dessa API não é prova de apresentação |
| WebGL via `EMSCRIPTEN_WEBGL_CONTEXT_PROXY_ALWAYS` + `OFFSCREEN_FRAMEBUFFER`, loop bloqueante | Cores sucessivas visíveis; três cores confirmadas nos PNGs durante o loop | O proxy explícito também é alternativa funcional para vídeo, embora não seja o backend escolhido |
| OffscreenCanvas com `emscripten_set_main_loop` a 60 Hz | Cores sucessivas visíveis durante execução | O instrumento diferencia renderização bloqueada de funcional |
| WebGL da página + buffer compartilhado, jogo no worker | Imagem muda durante loop bloqueante | Fronteira de apresentação proposta é viável |
| Padrão RGB, largura 241, altura 160 | 3 comparações completas com readback: zero bytes RGB diferentes | Canais, orientação e `UNPACK_ALIGNMENT=1` corretos nesse caso |
| Superfície lógica 241→480 e drawable 720×480→600×350 | Imagem continua e dimensões compartilhadas atualizam | Resize é independente da execução do guest |
| Crescimento de memória de 16 MiB para 80 MiB | 2 gerações de views detectadas; vídeo/entrada/áudio continuam | Não capturar o buffer inicial para toda a sessão |
| KeyX pressionado/solto via CDP | Worker observa `0x03FE`, depois `0x03FF` | Estado de tecla chega sem callback no event loop do worker |
| Blur após KeyX pressionado | Worker volta a `0x03FF` | Previne tecla presa |
| Página bloqueada por 750 ms | Publicações 5→58; após recuperação upload 58; 41 frames intermediários descartados | Produtor não bloqueia na página e consumidor recupera o mais recente |
| `WEBGL_lose_context` / restore | Contadores 1 lost / 1 restored; imagem volta | Recriação dos recursos GL é necessária e funciona no protótipo |
| AudioWorklet com fonte seno e depois PCM do jogo | Grafo `running`, callback consome PCM não nulo | Caminho de áudio sem SDL funciona; não é avaliação auditiva |
| AudioWorklet + RAB em módulo Wasm separado | Callback produz PCM; zero overflow do ring no teste sintético corrigido | Resampler existente pode ser reaproveitado sem carregar o jogo no worklet |
| Gesto real via CDP, sem flag de liberação de autoplay | AudioContext `running` | Start pode habilitar áudio sob a política normal do Chrome |

Teste adicional de `texImage2D` com uma view de SharedArrayBuffer foi **aceito com erro GL zero no Chrome deste ambiente**. Não declarar que WebGL necessariamente rejeita SAB. O plano usa staging local por previsibilidade de ciclo de vida, cópia verificável e compatibilidade a testar; otimizar essa cópia só depois da matriz de navegadores.

Os testes iniciais do áudio linear tiveram underruns; isso motivou testar RAB. No primeiro teste do módulo RAB, a factory retornava uma Promise mesmo com compilação wasm síncrona. O worklet não consumia o ring. Corrigido aguardando inicialização fora de `process()` e exportando `HEAP16`. Falhas de processor precisam virar estado observável; `AudioContext.state === running` sozinho não valida áudio.

### 4.1 Paridade do jogo

Os runs de investigação usam `GBARECOMP_SELFHEAL_RECOMPILE=0` explicitamente. O PK possui cobertura incompleta, incluindo código executado de IWRAM. São testes de host, não aprovação de um release FULLY STATIC. O JSON de cobertura e a lista TOML de misses foram coletados após cada run finalizado.

| Frames/VBlank final | Web com janela versus web sem janela | Cobertura |
|---|---|---|
| 600 | PNG final idêntico byte a byte; JSON de cobertura e fragmento de misses idênticos | 29 misses; 5.531.225 instruções interpretadas |
| 1.800 | PNG final idêntico byte a byte; JSON de cobertura e fragmento de misses idênticos | 36 misses; 38.016.147 instruções interpretadas |
| 10.800 | PNG final, JSON de cobertura e fragmento de misses idênticos entre web com janela, web sem janela **e nativo de referência** | 54 misses; 269.727.239 instruções interpretadas |

SHA-256 dos PNGs finais equivalentes:

```
600:  460a381006badc66b588a05372e2ff360244e8937e9056de0edbb6ff5d89fc11
1800: 60ab0df89295e8398ed7f16dd2a337d08db4d884adcf9a3fb5e017782efa029d
10800: dd28817213d4d466f0f6d5ad227d94d9fbbb3e927b3c9238c15e3baa89017911
```

Em 1.800 frames, o protótipo de buffer triplo publicou 1.800 e o consumidor submeteu 1.743 ao WebGL; upload final seq=1.800, 57 intermediários não exibidos. Os testes fazem screenshots e readback, e alguns foram executados simultaneamente. Esses números **não são um benchmark limpo de FPS** nem medição física de scanout.

Na execução de 10.800, `final_pc=0x080008c6`, `steps=11512`, `ppu_vcount=203`; os três modos concordaram. O backend publicou 10.800, o WebGL consumiu a publicação final e submeteu 10.666, descartando 134 intermediárias. O transporte de áudio publicou/consumiu 11.846.512 samples, com zero overflow do ring. O AudioWorklet usou RAB a 44.100 Hz e gerou PCM não nulo. Não foram medidos todos os eventos de concealment/underrun do RAB; zero overflow **não** significa qualidade auditiva já aprovada.

O executável nativo usado foi `gbarecomp-tailcall-work/link/pk_native_old`, baseline anterior às tail calls, com ROM/BIOS explícitos, `--no-window --frames 10800 --dump-png final.png` e self-heal recompilation desabilitado. Seu PNG e seus dois arquivos de cobertura foram comparados integralmente, não apenas os contadores do banner.

`lab/web-canvas/verify_results.py` validou automaticamente os controles negativo/positivo de apresentação decodificando os PNGs, as comparações de 600/1.800/10.800, paridade nativa 10.800, teclado, growth, context restore e consumo do DRC. Resultado final: PASS. O JSON consolidado é `results/verified-summary.json`.

### 4.2 Limites da evidência

Chrome headless com GPU real não substitui uma sessão interativa nem testes Firefox/Safari. Gamepad físico, controles móveis, filtros sharp/ColorLut integrados ao novo backend, sensores, qualidade auditiva, pressão longa de memória, fullscreen real e shutdown/restart de produção ainda precisam dos testes definidos abaixo. O protótipo mantém a alocação compartilhada viva depois de `close()` para permitir inspeção: isso é uma limitação intencional do laboratório, **não copiar para produção**.

## 5. Arquitetura final

```
Thread da página                         pthread do jogo
─────────────────                        ───────────────
Start / arquivos / estado                run_game / guest recompilado
DOM / teclado / gamepad  ── controles ──> HostWindow::pump()
ResizeObserver           ── dimensões ──> drawable_size()
requestAnimationFrame    <─ 3 slots RGB ─ HostWindow::present()
WebGL / textura / canvas                 FramePacer / present-in-place
AudioContext / ganho                     push_audio_samples()
         │                                     │
         ▼                                     ▼
AudioWorklet <──────────── ring SPSC de PCM ─────┘
   │
   ├─ módulo Wasm pequeno com recomp_audio_drc.h
   └─ PCM na taxa do AudioContext → saída
```

Não há chamadas GL/EGL no worker do jogo. O browser main não roda instruções do guest. `requestAnimationFrame` apenas apresenta: nunca determina quantos ciclos ou VBlanks devem ser executados.

O áudio usa seu próprio relógio de dispositivo; RAB converte o domínio do guest para esse relógio. Descartar um frame de apresentação não descarta ciclos de emulação nem amostras de áudio.

## 6. Contrato de memória e ABI

Criar `src/runtime/host_web_shared.h` como contrato explícito, versionado, de estruturas POD e atômicos wasm32. Não expor o layout de `Backend`, `std::vector`, `std::string` ou ponteiros nativos como protocolo JavaScript.

Header mínimo: magic, versão, tamanho em bytes, geração da sessão, estado do produtor, índice compartilhado do vídeo, dimensões desejadas, máscara de teclas, comandos, cursores de áudio, taxa de fonte/host e contadores. Separar, por alinhamento, os campos escritos pelo produtor dos escritos pelos consumidores quando possível. Usar atômicos `uint32_t` alinhados a 4 bytes; `static_assert` para sizeof, offsets, alinhamento e `is_always_lock_free`.

Gerar ou exportar os offsets para JS em um descritor de inicialização. Não manter números como `h[14]` duplicados manualmente em produção. O protótipo usa esses números por simplicidade; o produto deve ter nomes e validação de versão.

### Dimensões

A PPU atual declara `kMaxRenderWidth=480`, `kMaxRenderHeight=160`, RGB888. Cada slot precisa de **230.400 bytes**, além de metadados; três slots usam **691.200 bytes** de pixels. O frame tradicional tem 115.200 bytes. Derivar do header da PPU e usar assertions para detectar mudança do limite.

Cada slot carrega width, height, stride, seq e pixels. `stride=width*3`. Validar dimensões e tamanho antes de copiar ou criar a view JS. `set_surface_size` rejeita valores inválidos sem destruir a superfície anterior. Não confundir limite lógico da PPU com tamanho do drawable HiDPI.

### Crescimento de memória

O bootstrap entrega ao host uma função que obtém **o `wasmMemory.buffer` corrente**, mais ponteiro e descritor. A cada tick de UI e acesso de controle, comparar a geração/buffer e recriar views se necessário. Não guardar `HEAPU8.subarray` além do período em que a memória e o slot estejam garantidos.

O ring de áudio deve ser alocado antes de anexar o worklet e nunca realocado durante a sessão. Em memória compartilhada, o buffer antigo continua referindo a faixa antiga após growth; isso foi exercitado. Mesmo assim, se o protocolo vier a realocar ou trocar a memória, é obrigatório handshake de detach/attach com nova geração. Nunca supor que `memory.grow` torna automaticamente o worklet capaz de ver endereços novos.

## 7. Vídeo: buffer triplo SPSC sem fila crescente

Usar exatamente um produtor (thread do jogo) e um consumidor (rAF da página). A troca central é um único atômico que empacota índice de slot nos bits 0–1 e `DIRTY=4` no bit 2.

Inicialização: `front=0` privado do consumidor, `middle=1` compartilhado e limpo, `back=2` privado do produtor. Cada lado só acessa o slot que possui. A propriedade muda exclusivamente pelo exchange atômico.

Produtor, pseudocódigo implementável:

```cpp
// back pertence só ao produtor; seq é uint32_t local.
auto& slot = slots[back];
slot.width = width;
slot.height = height;
slot.stride = width * 3;
slot.seq = ++seq;
copy_or_grade_rgb888(slot.pixels, rgb, width, height);
const uint32_t previous = middle.exchange(back | 4u,
                                          std::memory_order_acq_rel);
back = previous & 3u;
if (previous & 4u) ++replaced_before_consume;
++published;
```

Consumidor, pseudocódigo JavaScript:

```js
if (Atomics.load(control, middleOffset) & 4) {
  const previous = Atomics.exchange(control, middleOffset, front);
  front = previous & 3;
  // Agora o produtor não pode tocar neste slot.
  const meta = readAndValidateMetadata(front);
  staging.set(slotBytes(front, meta.byteLength));
  uploadTexture(staging, meta);
  lastSeq = meta.seq;
}
// front continua pertencendo ao consumidor até o próximo exchange.
// Reapresentar textura existente quando resize/context-restore pedir.
```

**Por que é seguro:** enquanto o consumidor lê `front`, o produtor apenas escreve `back` e troca com `middle`. Um exchange da página devolve o front antigo ao middle ao mesmo tempo em que adquire o publicado mais recente. Se os exchanges concorrem, a ordem atômica decide qual frame foi adquirido; nenhum lado escreve o slot do outro. O par acquire/release publica também os pixels e metadados escritos antes da troca.

Não substituir isso por “latestIndex + memcpy” sem protocolo de propriedade: o produtor pode sobrescrever o slot durante a leitura. Não usar `volatile` como sincronização. Não usar spinlock/mutex no callback da página ou do worklet.

O produtor nunca espera por rAF. Se a página atrasar, ele recicla a publicação ainda não consumida. Essa política preserva o último frame, inclusive no encerramento, e limita a memória. O consumidor pode perder imagens intermediárias, mas não a coerência de um frame adquirido.

Seq é identificador, não instrumento de sincronização. Tratar wrap de uint32 com subtração modular `(next-prev)>>>0`; só considerar adiante distâncias inferiores a `2^31`. Não copiar o `seq<=lastSeq` simplificado do protótipo. Testar cruzando `0xffffffff`.

## 8. Renderer WebGL da página

Criar `packaging/web/host_web.js` e manter toda criação/destruição de recursos GL nesse módulo. Usar WebGL 1 para o caminho básico, suficiente para RGB888, textura NPOT e shader simples; WebGL 2 não é pré-requisito desta correção.

Inicialização: `canvas.getContext('webgl', {alpha:false, depth:false, stencil:false, antialias:false})`. Na versão final, não solicitar `preserveDrawingBuffer:true` apenas para screenshots: o laboratório o usou para inspeção; screenshots de aceite devem ser feitas no momento apropriado ou via FBO dedicado.

- Compilar/linkar shaders com checagem e mensagem de erro detalhada.
- Criar VBO para dois triângulos/triangle strip e uma textura RGB.
- Usar `CLAMP_TO_EDGE`, `NEAREST` inicial, sem mipmaps e `UNPACK_ALIGNMENT=1`.
- Alocar textura por `texImage2D` apenas quando dimensões mudarem. Por publicação, `texSubImage2D`.
- Copiar para um staging `Uint8Array` local pré-alocado, sem alocar um framebuffer novo por tick.
- Fazer UV Y invertido, uma vez: RGB da PPU começa na linha superior, enquanto coordenadas de renderização GL têm origem inferior. Não inverter duas vezes com shader e flag de upload.
- `ColorLut` permanece uma transformação de apresentação: aplicar ao copiar para o slot ou a staging própria do backend, sem modificar `live_fb`/PPU/oráculo.
- `linear_filter` altera min/mag da textura; nearest preserva pixel art.
- `sharp_filter` reproduz a política existente: prescale inteiro por nearest em textura/FBO intermediário, depois pequeno ajuste linear. Reusar `compute_sharp_prescale_factor`. Recriar FBO em mudança de tamanho e checar completude.

### Resize e HiDPI

Usar `ResizeObserver` no contêiner e observar mudanças de DPR. Tamanho CSS e backing-store são distintos. `canvas.width/height = round(clientSize*DPR)`, limitado por `MAX_RENDERBUFFER_SIZE`/`MAX_TEXTURE_SIZE` e orçamento de memória. Não aumentar as dimensões da PPU por causa de DPR.

`drawable_size()` deve devolver uma medida de aspecto consistente com o cálculo de view; documentar se é CSS ou pixels físicos e usar a mesma origem nos dois lados. Publicar width/height em um único uint32 atômico, 16 bits por dimensão, impondo limite 65.535 e os limites GL menores aplicáveis. O worker decodifica um único load e guarda o último par válido; não aceitar um par misturado durante resize concorrente. Um futuro limite superior requer nova versão de ABI.

Reproduzir `compute_presentation_layout` de `src/runtime/presentation_layout.h`: reduzir aspecto por gcd, preencher o maior retângulo proporcional e centralizar. Limpar as barras antes de desenhar. A página atual fixa `aspect-ratio:3/2`; revisar o contêiner para que expanded/adaptive view não fique acidentalmente presa a esse aspecto.

Resize e restauração precisam reapresentar a última textura mesmo **sem um frame novo**. Isso importa na pausa, fim do run e abas retomadas. O early-return do protótipo quando não há DIRTY ainda precisa dessa correção.

### Context loss

Registrar `webglcontextlost`: `preventDefault`, suspender chamadas GL, marcar estado `context-lost`, manter input/controle. Não bloquear o produtor. No restore, recriar programa/VBO/texturas/FBOs e reapresentar o último frame válido. Se não houver textura local preservada, usar os bytes de staging e metadados guardados.

Falha de recuperação deve ser visível e oferecer reinicialização da sessão. Não continuar incrementando contadores de submissão GL durante context loss.

## 9. Entrada, controles e pausa

Listeners DOM executam na página. O worker não depende de `postMessage` processado por seu event loop para receber input.

Máscara GBA active-low: `0x03ff` é tudo solto. Padrões a preservar:

| Bit | Botão | KeyboardEvent.code |
|---|---|---|
| 0 | A | KeyX |
| 1 | B | KeyZ |
| 2 | Select | ShiftRight |
| 3 | Start | Enter |
| 4 | Right | ArrowRight |
| 5 | Left | ArrowLeft |
| 6 | Up | ArrowUp |
| 7 | Down | ArrowDown |
| 8 | R | KeyV |
| 9 | L | KeyC |

Usar `code`, para não depender do caractere/idioma. Capturar somente quando a superfície do jogo estiver ativa; não roubar teclas de inputs/textareas/controles editáveis. Usar `preventDefault` apenas para teclas reconhecidas. Tornar o canvas focável e focá-lo no Start/clique. Em blur, visibility hidden, desconexão de gamepad e detach: limpar estados de dispositivos e comandos pendentes apropriados.

Teclado/gamepad/toque mantêm máscaras locais separadas; combinar botões pressionados por OR e converter para active-low antes de publicar. Não permitir que o release de um dispositivo solte um botão que outro mantém pressionado. Gamepad usa API da página, e seu polling deve continuar mesmo quando não houver frame novo de vídeo. Documentar mapeamento de botões/eixos, deadzone e slots; sensores não disponíveis são capacidade ausente, nunca valores inventados.

Eventos de borda (pause, save/load, volume, fullscreen) usam ring de comandos SPSC ou contadores por comando com sequência. Um bool por ação pode perder dois cliques entre pumps. Para save/load com argumento slot, usar comandos `{seq,kind,arg}`. Overflow é contado e informado; não substituir silenciosamente um save pelo load seguinte.

`HostWindow::pump()` apenas lê o snapshot e consome comandos, preenchendo `HostWindow::Events`. Reusar a lógica existente de aplicação ao bus. `service_events()` na web não chama SDL: faz trabalho de controle barato/observabilidade sem consumir duas vezes eventos de borda.

### Fullscreen e configurações

`requestFullscreen()` deve ser executado diretamente em um gesto na página; uma solicitação posterior do worker não herda automaticamente user activation. Refletir `fullscreenchange`/erro para o estado compartilhado. Mode 2 (exclusive desktop) não existe como tal na web: normalizar explicitamente para fullscreen do navegador e informar a capacidade.

`load_input_config` deve preservar defaults e valores suportados de keybinds/config. Se houver valores numéricos SDL, implementar tabela explícita para o subconjunto aceito; não tratar o número como `KeyboardEvent.keyCode`. Chaves sem suporte precisam de diagnóstico. Getter/setter de volume, scale, filtros, FPS e Assist deve ter estado real. Não copiar os stubs do laboratório.

### Pausa e aba oculta

Adicionar serviço de pausa no hook present-in-place, no ponto em que o guest já alcançou a fronteira de frame: enquanto pausado, processar input/quit e esperar com `sleep_for` de poucos ms na pthread. Não retornar uma nova continuação artificial para o dispatcher e não avançar o guest durante pausa. Ao retomar, resetar FramePacer e pedir reset/preroll do áudio por protocolo.

Política recomendada de aba oculta: pausa automática, distinguindo de pausa manual para não despausar quem já estava pausado. A página informa visibility por estado compartilhado; o host aplica na próxima fronteira segura. rAF pode ser suspenso em background: o protocolo não pode depender dele para quit/pause/input-clear.

## 10. Áudio sem SDL, com o resampler existente

Implementar ring SPSC de PCM S16 mono do jogo para AudioWorklet. O produtor tem o cursor write; o consumidor tem read. Cursor uint32 monotônico, aritmética modular; capacidade potência de dois e inferior a `2^31`. No protótipo foram 32.768 samples (0,5 s a 65.536 Hz); essa é capacidade máxima, **não latência alvo**.

Produtor:

1. acquire-load de read, calcular espaço `capacity - uint32(write-read)`.
2. Copiar samples para as posições livres, tratando wrap.
3. release-store do novo write.
4. Se não houver espaço, nunca bloquear o guest nem mover o cursor read do consumidor. Contar overflow e solicitar recuperação via geração/reset. Não transformar drop/flush contínuo em mecanismo normal de sincronização.

Consumidor:

1. acquire-load de write, consumir somente samples publicados.
2. Copiar para buffer de entrada local do DSP em lotes limitados.
3. release-store do novo read após a cópia.
4. Executar resampling e preencher exatamente `outputs[0][0].length`; não assumir eternamente quantum de 128.

### Reaproveitamento do RAB

Criar `src/runtime/host_web_audio_dsp.cpp`, módulo Wasm pequeno separado contendo `RECOMP_AUDIO_DRC_IMPL` e wrappers de `rab_init`, `rab_push`, `rab_pull`, reset/free e stats. Compilar apenas esse módulo para o worklet; não instanciar os ~80 MB do jogo nele.

Dentro do AudioWorklet, **RAB inteiro pertence a uma única thread**. Somente ela chama push/pull e acessa `rab_bridge`. Assim não compartilhamos os cursores não-atômicos de `recomp_audio_drc.h` entre C++ e JS, não introduzimos mutex no áudio e preservamos o resampler bandlimited existente.

Alocar coeficientes, ring RAB, buffers de entrada/saída e memória do módulo antes de marcar áudio READY. O callback não faz malloc, fetch, logging por quantum, waits ou chamadas síncronas à página. O laboratório mandou stats esporádicas por port; produção deve usar counters compartilhados ou frequência baixa e limitada.

Configuração inicial alinhada com SDL: mono; taxa de host é `AudioContext.sampleRate` (o teste retornou 44.100 Hz); target RAB 60 ms; preroll 250 ms. Medir e ajustar preroll depois, sem alterar o guest. Um RAB vazio pode emitir silêncio/fade/concealment: saída não nula não comprova ausência de underrun. Expor stats de underrun/overflow/concealment, fill e correção.

### Taxa da fonte

Não escolher 32.768 ou 65.536 pelo comentário. O teste PK após BIOS usou 65.536. A inspeção de `GbaAudio::update_soundbias()` confirmou quatro taxas: `16777216 / (512 >> resolution)`, ou 32.768, 65.536, 131.072 e 262.144 Hz. `write_io8` nos offsets 0x088/0x089 chama `sample_until_current_time()` antes de atualizar SOUNDBIAS. `ring_push` guarda somente int16 hoje, e `drain_samples` pode atravessar uma mudança de taxa sem a informar.

Implementar metadados de apresentação, sem mudar os samples: vetor paralelo de tags de resolução (uint8, mesmo índice/tamanho do ring PCM), escrito em `ring_push`; novo `drain_sample_block(out,max,rate)` que para na primeira mudança de tag. Preservar `drain_samples` existente para callers antigos. No runner web, drenar blocos limitados até esgotar o budget da fronteira e passar taxa/epoch em cada bloco; usar o mesmo caminho nos dois locais de envio do runtime. O ring compartilhado precisa publicar descritores de bloco `{count,sourceRate,epoch}` junto com PCM (por slots de blocos ou ring de descritores), não apenas um campo global “taxa atual”.

Tags pertencem à fila de apresentação, não à síntese. Auditar reset, overflow e deserialize. No restore web, descartar a fila de playback anterior e iniciar nova geração, sem alterar `samples_generated_` nem estado dos canais; não reconstruir tags desconhecidas de um snapshot antigo por suposição. O formato nativo de save-state não deve ser alterado implicitamente por essa metadata nova.

Preservar a taxa associada às amostras:

- Acrescentar metadados de taxa/epoch ao transporte, a partir da taxa efetiva do mixer.
- Se uma drenagem pode misturar taxas, dividir os blocos na mudança de taxa no produtor do áudio; ler apenas a taxa atual ao final do frame não identifica samples anteriores.
- Ao trocar epoch, o consumidor encerra o segmento anterior pela contagem/duração de samples, não pela espera de silêncio do RAB (concealment pode ser contínuo). Drenar a cauda de filtro de forma limitada, aplicar transição suave e selecionar o estado da nova taxa. Prealocar os quatro bancos de coeficientes/estado antes de READY; não chamar `rab_init`/malloc dentro de `process()`. Não reinterpretar backlog na nova taxa. Essa extensão de troca de segmentos precisa do teste de taxa variável: o protótipo validou apenas fonte fixa de 65.536.
- Essa é uma mudança de metadados/transporte, não uma reescrita da geração de áudio nem um novo modelo HLE.

Corrigir a documentação da interface de áudio e manter o comportamento nativo coberto por testes. O canvas pode ser aprovado independentemente; declarar áudio genérico pronto exige esse contrato correto.

### Build do módulo DSP

O comando abaixo foi exercitado para o módulo mínimo do laboratório; no produto incluir exports adicionais de lifecycle/stats:

```bash
em++ -O2 -Isrc/runtime src/runtime/host_web_audio_dsp.cpp --no-entry \
  -sENVIRONMENT=worklet -sMODULARIZE=1 -sEXPORT_NAME=createGbrAudioDSP \
  -sSINGLE_FILE -sWASM_ASYNC_COMPILATION=0 -sFILESYSTEM=0 \
  -sEXPORTED_RUNTIME_METHODS=HEAP16 -sINITIAL_MEMORY=16777216 \
  -o "$WEB_OUT/audio_dsp.js"
```

Concatenar o factory gerado com `audio_worklet.js`, ou empacotar em um módulo suportado pelo loader escolhido. `audioWorklet.addModule()` carrega esse arquivo, sem `importScripts` e sem fetch executado no worklet.

**Mesmo com `WASM_ASYNC_COMPILATION=0`, a factory do Emscripten 6.0.9 é assíncrona.** Aguardar `createGbrAudioDSP().then(...)` no bootstrap; enquanto não READY, `process` emite silêncio. Capturar rejeição e `processorerror`, e não iniciar o guest no modo áudio habilitado antes do handshake READY.

### Start, mute e shutdown

No handler do gesto: criar AudioContext e chamar `resume()` antes de awaits de rede. Depois carregar/instanciar worklet, anexar ring e aguardar READY. Volume/mute podem usar GainNode com rampas; não parar o consumo do ring apenas porque o usuário mutou.

Autostart de teste não é garantia de permissão de áudio. Se suspenso, mostrar botão “Ativar áudio”. Falha de dispositivo não derruba vídeo; o estado deve dizer áudio indisponível/suspenso, sem `dummy` oculto.

Reset por pause/load/epoch: request e acknowledge em campos separados, sem ambos os lados sobrescreverem cursores livremente. Durante reset, produtor para de publicar naquele ring; consumidor reconhece, zera seu estado DSP/cursor de modo acordado, e produtor recomeça em uma nova geração. Ao fechar: sinalizar stop, parar callback/desconectar e aguardar ack antes de liberar a memória compartilhada.

## 11. Lifecycle e bootstrap

Estados explícitos: `idle → loading → ready → running → stopping → exited`, além de `failed`. Vídeo e áudio têm subestados independentes (`context-lost`, `audio-suspended`, etc.).

1. A página verifica secure context/cross-origin isolation/SharedArrayBuffer e criação WebGL antes de lançar guest. Tail calls devem ser verificadas por um pequeno `WebAssembly.validate` de módulo conhecido contendo return_call ou por erro de compilação claramente categorizado.
2. Criar os serviços da página antes de `game.js`. O canvas **não** é transferido.
3. `preRun` carrega ROM/BIOS e valida erros HTTP. Balancear run dependencies no erro sem permitir que o jogo inicie com assets incompletos; usar estado de abort explícito, não remover a dependência e prosseguir inadvertidamente.
4. Quando `HostWindow::open()` for chamado, alocar/zerar o protocolo e anexar usando uma chamada de bootstrap à página. Uma chamada síncrona de setup é aceitável; por frame, nenhuma é necessária.
5. Confirmar ABI e readiness antes da primeira publicação. Se áudio não estiver autorizado, usar estado explícito e política escolhida pelo usuário.
6. `close()` publica producer-done e sequência final. Consumidor pode apresentar a última publicação pendente antes de parar; isso não exige atrasar frames de guest.
7. Cancelar rAF, observers e listeners; desconectar AudioWorklet/GainNode; reconhecer que nenhum consumidor acessa buffers; só então liberar. Timeout deve encerrar a sessão e preservar segurança da memória, não fazer free concorrente.
8. `onExit`/`onAbort` recolhem diagnósticos e encerram serviços também em falhas parciais.

Reiniciar o runtime monolítico Emscripten com pthreads na mesma instância não está demonstrado. Implementação inicial pode oferecer reinício por reload completo, explicitamente. Não reexecutar `main()` na instância terminada. O novo backend não transfere canvas, mas threads, MEMFS, handlers e AudioContext ainda precisam de lifecycle correto.

## 12. Mudanças por arquivo

| Arquivo | Trabalho necessário |
|---|---|
| `src/runtime/host_window.h` | Preservar API de vídeo; corrigir contrato de áudio e acrescentar taxa/epoch ou API de blocos conforme §10; documentar métodos e capacidades web |
| `src/runtime/host_window_web.cpp` (novo) | Implementar todos os símbolos HostWindow para Emscripten; buffer triplo, ColorLut, input snapshot/comandos, configuração, áudio ring, lifecycle e métricas |
| `src/runtime/host_web_shared.h` (novo) | ABI versionada, limites derivados da PPU, offsets/layout e assertions; protocolo SPSC de vídeo/áudio/controle |
| `src/gba/gba_audio.h`, `src/gba/gba_audio.cpp` | Tags de taxa no playback ring e nova drenagem por bloco; manter síntese e drenagem antiga; reset de playback no restore web |
| `src/runtime/host_web_audio_dsp.cpp` (novo) | Wrapper pequeno RAB de uso exclusivo pelo AudioWorklet; sem dependência da ROM/SDL/runtime do jogo |
| `packaging/web/host_web.js` (novo) | WebGL, rAF, staging, shaders, filtros, resize/HiDPI, context loss, input/DOM/fullscreen, bootstrap e teardown |
| `packaging/web/audio_worklet.js` (novo) | Consumir ring com Atomics, módulo DSP, READY/reset/stop, preencher saída e expor stats |
| `packaging/web/index.html` | Carregar host; Start por gesto; estados de capabilities/áudio; focus; erros/teardown; download de diagnósticos; revisar CSS de aspecto |
| `packaging/web/build_web.sh` | Seleção web sem SDL; construir e copiar JS/DSP; flags/paths isolados; manifest de build |
| `CMakeLists.txt` | Selecionar exatamente um backend; não procurar/linkar SDL nem adapter SDLRenderer2 no wasm; manter nativo e headless nativo existentes |
| `cmake/runtime.cmake.in` | Propagar flags/dependências web no helper quando ele produzir executável de navegador; separar builds Node de browser |
| `tools/cli.py` | Auditar template para não divergir do helper, preservar `-mtail-call`; acrescentar integração web somente onde exporta/linka browser |
| `src/runtime/runtime.cpp` | Manter ambos os pontos de present/audio (hook e loop externo); metadados de áudio; pausa interna segura; métricas distintas; sem mudar dispatch guest |
| `src/runtime/host_window.cpp` | Nativo permanece SDL; melhorar log da primeira falha do renderer antes do fallback sem forçar backend web |
| `src/runtime/overlay_loader.cpp` e diagnóstico de misses | No wasm, não anunciar compilador/background healing disponível; manter misses/coverage exportáveis e strict-static honesto |
| `tests/web/*` (novos) | Harness C++ sintético, driver browser/CDP, testes de protocolo, comparação de pixels/cobertura e falhas de lifecycle |

`GBARECOMP_RUNTIME_UI`: o adapter atual é ImGui SDL_Renderer2. Não o linkar ao host web. Na primeira entrega, deixar UI web explícita em HTML para os controles implementados e rejeitar em CMake a combinação que exige aquele adapter, com mensagem útil. Portar overlay ImGui para outro renderer é tarefa própria, não stubs silenciosos que fingem desenhar menus.

### Seleção CMake e flags

Introduzir opção explícita, default OFF, para distinguir alvo browser de Emscripten/Node. Retirar `src/runtime/host_window.cpp` da lista incondicional:

```cmake
option(GBARECOMP_WEB_HOST "Build the browser HostWindow backend" OFF)
if(GBARECOMP_WEB_HOST AND NOT EMSCRIPTEN)
    message(FATAL_ERROR "GBARECOMP_WEB_HOST requires Emscripten")
endif()
if(GBARECOMP_WEB_HOST)
    target_sources(gbarecomp_runtime PRIVATE src/runtime/host_window_web.cpp)
    target_compile_definitions(gbarecomp_runtime PUBLIC GBARECOMP_WEB_HOST=1)
else()
    target_sources(gbarecomp_runtime PRIVATE src/runtime/host_window.cpp)
endif()
```

`build_web.sh` passa `-DGBARECOMP_WEB_HOST=ON`. Condicionar procura, definições e linkage SDL a `NOT EMSCRIPTEN` nesta integração. Emscripten/Node com a opção OFF usa o stub já existente de `host_window.cpp`, sem SDL/DOM, para execução headless. O caminho nativo mantém sua detecção atual de SDL. Proteger também a seleção de runtime UI; não deixar uma descoberta residual do SDL do host decidir o backend wasm.

No link do browser manter:

```
-pthread -mtail-call
-sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=4
-sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=134217728
-sSTACK_SIZE=16777216 -sDEFAULT_PTHREAD_STACK_SIZE=16777216
-sFORCE_FILESYSTEM
-sEXPORTED_RUNTIME_METHODS=FS,ENV,addRunDependency,removeRunDependency
-sENVIRONMENT=web,worker -sEXIT_RUNTIME=1
```

Remover do browser: `-sUSE_SDL=2`, `-sOFFSCREENCANVAS_SUPPORT`, `-sOFFSCREEN_FRAMEBUFFER` e eventual `OFFSCREENCANVASES_TO_PTHREAD`. Não reduzir stacks/pool/memória no mesmo patch sem medições. Adicionar apenas os exports necessários ao bootstrap; não expor todo o runtime.

`build_web.sh` não deve reutilizar `build-wasm-mt` indiscriminadamente: aceitar `GBARECOMP_WEB_BUILD_DIR`, `GBARECOMP_WEB_GAME_BUILD_DIR` e `GBARECOMP_WEB_OUT_DIR` ou argumentos equivalentes. Resolve-los para caminhos absolutos e garantir que CMakeCache pertence à mesma source tree. A worktree deve conseguir construir sem escrever nos builds da árvore original.

Manter checagem do BIOS gerado e de tail calls; remover o gate “SDL2 found” do caminho web. Criar gate positivo para `host_backend=web`. Copiar sempre host JS, audio worklet/DSP, index e manifest; mudanças só em JS precisam chegar ao output sem regerar a ROM.

## 13. Observabilidade, cobertura e saves

Criar snapshot de host de baixo custo acessível para o harness e UI: ABI/generation, estado, published/consumed/uploaded/replaced, sequência final, dimensões, renderer, context losses, contadores de input/overflow, áudio READY/state/fill/under/over/concealment, tempo de cópia/upload e erro fatal. Rings de amostras devem ser limitados; não logar uma linha por frame.

Não exportar inspeção informal de memória guest pela ponte do canvas. Para divergência de emulação, preservar as superfícies estruturadas já existentes e comparar a primeira divergência em eventos de hardware. O canvas é uma fronteira de apresentação; seu oráculo de pixels é o framebuffer que recebeu.

O banner atual de miss pode dizer “healing in the background” mesmo com self-heal desabilitado. Corrigir essa descrição no wasm e na condição de diagnóstico desabilitado. Testes de host com bridge interpretada devem dizer NOT_STATIC e exportar `recomp_coverage_*.json` e `recomp_master_misses_*.toml.frag` do MEMFS. Nunca auto-merge no TOML.

Release que se declara FULLY STATIC precisa passar `GBARECOMP_STRICT_STATIC=1`, que aborta no primeiro miss. A correção do canvas não transforma o PK atual em um jogo de cobertura completa. Falha nesse teste de coverage não deve ser mascarada por renderer/áudio.

Saves em MEMFS continuam voláteis. Informar e oferecer exportação até existir IDBFS. Não expandir esta tarefa para persistência completa sem distinguir escopos. Antes de eventual IDBFS, auditar também que o auto-flush não depende apenas de voltar ao loop externo quando present-in-place está ativo.

## 14. Ordem de implementação e gates

1. **Congelar baseline.** Registrar HEAD/submódulos, emcc/Chrome, hashes ROM/BIOS, archives/configs. Guardar PNG, saída estruturada e coverage de 600/1.800/10.800 sem janela. Não regenerar a ROM para uma mudança só de host.
2. **Backend e ABI.** Criar seleção CMake, estruturas, buffer triplo e lifecycle mínimo. Fazer link do jogo sem SDL. Manter todos os símbolos HostWindow definidos com capacidades explícitas.
3. **Vídeo sintético.** Testar RGB, canto superior, padrão assimétrico, largura ímpar, dimensões máximas, filtros, resize sem frame novo e memory growth. Gate: byte equality em nearest/raw e context loss restaurado.
4. **Entrada e controle.** Teclas reais, blur, comandos, input replay/record existente, pause/resume na fronteira interna, fullscreen por gesto. Gate: aplicação no bus pelo caminho normal e nenhuma tecla presa.
5. **Áudio.** Ring, módulo RAB, READY, taxa/epoch, volume, underrun/overflow/reset/stop. Gate: fonte sintética validada, source/host rate corretos e callback sem bloqueio; depois áudio de jogo.
6. **Integração de página/build.** Start normal sem variáveis SDL, falhas de assets/capabilities com estado útil, cleanup e diagnóstico exportável. Clean build isolado.
7. **Regressão e matriz de navegadores.** Rodar testes abaixo, incluindo os nativos aplicáveis. Separar limitação de cobertura ROM de regressão de host.
8. **Revisão final.** Remover flags de laboratório, stubs, `preserveDrawingBuffer` de inspeção, readPixels por frame, leaks intencionais e caminhos absolutos. Atualizar documentação de comandos e deixar manifest de versão reprodutível.

Não promover o código do laboratório inteiro para `src/`: ele tem métodos de configuração vazios, observabilidade experimental, shutdown incompleto e simplificações de áudio/seq. Usar as partes provadas como referência para implementar o contrato acima.

## 15. Testes de aceite detalhados

### A. Concorrência/protocolo

- Produtor rápido/consumidor lento e o inverso; verificar que cada frame adquirido contém um único padrão/seq em todos os pixels e metadados.
- Suspender consumidor por 750 ms e vários segundos; memória fica limitada, produtor progride, retomada recebe o último frame.
- Seq e cursores próximos do wrap uint32; sem falso “frame antigo”, underflow de espaço ou salto de ring.
- `memory.grow` com consumidores vivos e após troca de superfície.
- Último frame seguido imediatamente por close; consumidor consegue apresentar a publicação final antes do detach.
- Teardown parcial antes/depois de attach; double-close; nenhum callback usa memória liberada.

### B. Pixels e layout

- Padrão assimétrico RGB24 em 240×160, 241×160 e 480×160; comparar readback normalizado de origem GL com todos os bytes esperados.
- Raw/nearest: igualdade exata. ColorLut: comparar contra transformação CPU existente, não contra PPU alterada.
- Linear e sharp: comparar política/saída com referência do filtro, tolerância explícita por canal se o GPU arredondar. Não exigir igualdade de nearest para linear.
- DPR 1/2 e resize fracionário, window estreita, fullscreen, expanded/adaptive e resize durante pausa.
- Context loss/restore com e sem novas publicações. Recursos recriados, imagem correta, counters honestos.
- WebGL indisponível: erro explícito antes da execução, sem fallback para software.

### C. Entrada

- Down/up de todos os defaults; combinar duas teclas; repeat de keydown não dispara múltiplas ações de borda.
- Blur/visibility/disconnect limpam botões. Tecla pressionada ao entrar em input textual não fica presa.
- Gamepad real e teclado simultâneos; deadzone; disconnect enquanto pressionado.
- Pausa mantém contadores guest estáveis; retomar não exige redispatch de PC interior novo.
- Registrar entrada via `GBARECOMP_INPUT_RECORD=/data/input.csv`, recolher o arquivo e comparar aplicação/replay pelo mecanismo existente.

### D. Áudio

- Seno conhecido a 440 Hz nas quatro taxas 32.768/65.536/131.072/262.144 de origem e 44.100/48.000 de host; medir frequência/continuidade depois de preroll, não apenas “samples != 0”.
- Comparar RAB do worklet com o mesmo RAB nativo sob sequência controlada de pushes/pulls; saídas e stats com tolerância declarada para float.
- Fonte muda taxa com backlog: samples não são reproduzidos com duração errada.
- Mute/volume com rampas, suspend/resume, buffer vazio/cheio, produtor parado, browser main ocupado, mudança de epoch e shutdown.
- Sem flag de autoplay: clique real libera áudio; autostart suspenso oferece retomada. Simular falha de worklet/module e verificar mensagem + estado de vídeo preservado.
- Medir tempo de processamento e evitar callback acima do quantum. Escuta humana de BIOS/gameplay ainda é necessária para avaliar cliques/concealment desagradável.

### E. Jogo e regressão nativa

- 600/1.800/10.800 frames, sem entrada: `--no-window` contra `--window`, mesmos assets/config, PNG final, PC/steps/PPU e coverage/misses.
- Comparar output web contra baseline nativo no mesmo ponto de parada. Igualdade de screenshot final não prova todos os frames; acrescentar hashes de frames em pontos determinados se o patch tocar o conteúdo.
- Run interativo com GPU real, pelo menos menu/gameplay, input e áudio; Firefox e Safari das versões instaladas registradas no relatório, além de Chrome.
- Clean build nativo e `ctest --output-on-failure`; se alterar metadata de áudio/pausa, incluir testes relevantes de BIOS, áudio e controle. Não alterar arquivos gerados de guest só para obter verde.
- Teste `GBARECOMP_STRICT_STATIC=1` quando houver corpus de cobertura completa; no PK atual, registrar a falha de cobertura como limitação conhecida, nunca como aprovação.

## 16. Comandos de implementação e validação

Todos os exemplos usam bash. `GBA_ROOT` deve ser a raiz da worktree de implementação. O projeto exportado contém seu `generated/`; `BIOS_GEN` contém `bios_recompiled.cpp` e `bios_dispatch_table.cpp`. Não apontar para o diretório de stubs.

```bash
# Na árvore existente; escolher nome/path ainda não usados.
git worktree add -b feat/web-host ../gbarecomp-web-host HEAD
cd ../gbarecomp-web-host
git submodule update --init --recursive
source "$HOME/emsdk/emsdk_env.sh"
export GBA_ROOT="$PWD"
export GAME_PROJECT="/caminho/absoluto/para/projeto-exportado"
export BIOS_GEN="/caminho/absoluto/para/bios-gerado"
export ROM_PATH="/caminho/absoluto/para/pk.gba"
export BIOS_PATH="/caminho/absoluto/para/gba_bios.bin"
export GBARECOMP_WEB_BUILD_DIR="$GBA_ROOT/build-web-host"
export GBARECOMP_WEB_GAME_BUILD_DIR="$GBA_ROOT/build-web-game"
export GBARECOMP_WEB_OUT_DIR="$GBA_ROOT/out-web-host"
export WEB_OUT="$GBARECOMP_WEB_OUT_DIR"

# Depois de implementar os arquivos e as opções de build descritos neste plano:
bash packaging/web/build_web.sh "$GAME_PROJECT" "$BIOS_GEN" "$ROM_PATH" "$BIOS_PATH"
python3 packaging/web/serve.py "$WEB_OUT" 18081
```

Se o submódulo apontar para um commit local ainda não publicado, inicializar a partir do repositório local que contém esse commit ou publicá-lo pelo fluxo autorizado do projeto. Não trocar o ponteiro por outra revisão para “fazer o build passar”.

Em outro terminal, checar headers:

```bash
curl -I http://127.0.0.1:18081/game.wasm
# Esperado: application/wasm, COOP same-origin, COEP require-corp.
```

URLs de investigação, com ROM SHA carregado pelo `rom_sha1.js`:

```
http://127.0.0.1:18081/?args=--window%20--frames%201800%20--dump-png%20/data/final.png&env=GBARECOMP_SELFHEAL_RECOMPILE=0
http://127.0.0.1:18081/?args=--no-window%20--frames%201800%20--dump-png%20/data/final.png&env=GBARECOMP_SELFHEAL_RECOMPILE=0
```

Repetir com 600 e 10.800. Em todos, clicar Start para validar gesto de áudio. Harness de automação deve usar clique real via driver/CDP no teste de autoplay; `.click()` sintético com flag de autoplay liberado é apenas teste do transporte.

No harness, coletar em `onExit`: `/data/final.png`, `/recomp_coverage_BPEE.json` e `/recomp_master_misses_BPEE.toml.frag` via `Module.FS.readFile`. Gravar eventos de erro, status e métricas de host. Não concluir sucesso apenas porque Chrome encerrou; exigir código de saída guest zero, publicação final consumida e comparações aprovadas.

Clean build nativo de validação:

```bash
cmake -S "$GBA_ROOT" -B "$GBA_ROOT/build-native-check" \
  -DCMAKE_BUILD_TYPE=Release -DGBARECOMP_COMPILER_CACHE=OFF \
  -DGBARECOMP_GENERATED_BIOS_DIR="$BIOS_GEN"
cmake --build "$GBA_ROOT/build-native-check" --parallel 10
ctest --test-dir "$GBA_ROOT/build-native-check" --output-on-failure
```

Esses comandos pressupõem as alterações futuras do plano, especialmente os diretórios configuráveis de `build_web.sh`; não fingir que a versão atual já entende tais variáveis.

## 17. Reproduzir a hipótese decisiva sem ROM

Criar um programa Emscripten que desenha vermelho/verde/azul a cada 700 ms e registra em um snapshot da página `{frame,phase,done}`. Compilar duas variantes do mesmo código:

- Variante bloqueante: `while (elapsed<6500) { glClear(...); glFlush(); sleep_for(30ms); }`.
- Variante cooperativa: mesma função de desenho chamada por `emscripten_set_main_loop(draw,60,1)`, cancelando após 6,5 s.

Em ambas, criar/ativar WebGL no worker via `emscripten_webgl_create_context`, `proxyContextToMainThread=EMSCRIPTEN_WEBGL_CONTEXT_PROXY_DISALLOW` e transferir `#canvas`:

```bash
em++ probe.cpp -O2 -pthread \
  -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=1 \
  -sOFFSCREENCANVAS_SUPPORT -sOFFSCREENCANVASES_TO_PTHREAD='#canvas' \
  -sEXIT_RUNTIME=0 -o probe.js
```

A página precisa de `<canvas id="canvas">`, `Module.canvas` e servidor COOP/COEP. Fazer screenshots durante o loop (por exemplo a cada 800 ms), não só depois de `main` retornar. Repetir a variante bloqueante com `explicitSwapControl=true` e `emscripten_webgl_commit_frame()`; registrar retorno e presença de `GLctx.commit`.

Oráculo: fase de cor conhecida versus bitmap visível naquele intervalo. O controle cooperativo deve exibir as cores; se não exibir, investigar a ferramenta/browser antes de concluir qualquer coisa sobre o loop. Esse foi o controle positivo empregado nesta sessão.

## 18. Alternativas e justificativa da escolha

| Alternativa | Avaliação |
|---|---|
| SDL software + áudio dummy | Faz aparecer imagem, mas desliga áudio e mantém acoplamento/proxy síncrono; não atende o objetivo |
| OffscreenCanvas no worker do jogo sem mudar loop | Rejeitada experimentalmente: canvas não atualiza durante execução bloqueante |
| Reescrever execução para event loop/Asyncify | Pode viabilizar OffscreenCanvas, mas toca continuação/pilha/custo do guest; desnecessário para publicar RGB já pronto |
| Worker exclusivo para apresentação com OffscreenCanvas e event loop livre | Arquitetura válida; mais lifecycle e um worker; considerar se houver gargalo medido de UI |
| WebGL proxied explicitamente por API Emscripten | Passou no padrão de cores com loop bloqueante e swap explícito; desempenho integrado não medido. Não resolve sozinho áudio/input/lifecycle; mantido como alternativa, não declarado impossível |
| WebGL da página + buffer triplo + AudioWorklet | Exercitado com o jogo, preserva loop e separa responsabilidades; escolhido |

A decisão não depende de chamar a GPU a partir de C++. A PPU já produz pixels em CPU. O trabalho do WebGL é apresentar uma textura pequena; a principal correção é propriedade, sincronização e ciclo de vida.

## 19. Fontes técnicas primárias e código verificado

Fontes externas conferidas em 2026-09-13; comportamento do SDK instalado prevalece sobre exemplos antigos:

- [Emscripten html5.h / contextos WebGL e threading](https://emscripten.org/docs/api_reference/html5.h.html): criação, ativação, modos de proxy e afinidade de contexto.
- [Emscripten Runtime Environment](https://emscripten.org/docs/porting/emscripten-runtime-environment.html): integração com event loop e apresentação.
- [HTML Standard — OffscreenCanvas](https://html.spec.whatwg.org/multipage/canvas.html#the-offscreencanvas-interface): placeholder e atualização de renderização pelo agente proprietário.
- [Emscripten Wasm Audio Worklets](https://emscripten.org/docs/api_reference/wasm_audio_worklets.html): ambiente worklet, execução não bloqueante e opção de módulo independente com `ENVIRONMENT=worklet`.
- [Emscripten pthreads](https://emscripten.org/docs/porting/pthreads.html): `PROXY_TO_PTHREAD`, restrições de thread principal e memória compartilhada.

Arquivos do SDK inspecionados: `src/settings.js`, `src/lib/libhtml5_webgl.js`, `src/lib/libegl.js`, e, no port SDL2, `src/video/emscripten/SDL_emscriptenframebuffer.c`, `SDL_emscriptenopengles.c`, `src/audio/emscripten/SDL_emscriptenaudio.c`.

As referências fundamentam as APIs; a escolha da arquitetura é uma conclusão dos experimentos e da inspeção do loop deste projeto.

## 20. Artefatos preservados e reprodução do laboratório

O plano não depende desses arquivos para definir a implementação. Eles preservam as provas e permitem repetir o protótipo no ambiente desta investigação:

- Worktree: `/Volumes/SSD_1TB/www/fabio/gbarecomp-web-canvas`.
- `lab/web-canvas/probe.cpp`, `build_probe.sh`: controles OffscreenCanvas e proxy explícito.
- `host_window_web.cpp`, `web_host.js`, `host_probe.cpp`: backend mínimo e fonte RGB sintética; somente laboratório.
- `audio_dsp.cpp`, `audio_worklet_drc.js`, `build_audio.sh`: RAB em módulo Wasm independente. `audio_worklet.js` guarda a primeira versão com resampling linear, não a versão final usada no run longo.
- `browser.py`, `test_host.py`, `test_transport.py`, `test_game.py`: driver Chrome/CDP, captura e testes. Dependência Python: `websocket-client`; comparação PNG usa somente stdlib.
- `verify_results.py`: assertions sobre evidências já coletadas; `results/verified-summary.json`: relatório consolidado.
- `results/game600`, `game1800`, `game10800-drc`, `headless600`, `headless1800`, `headless10800`, `native10800`: saídas e cobertura.
- `manifest.json`: versões e hashes das entradas/fontes. O pacote `docs/WEB_WASM_CANVAS_EVIDENCE_2026-09-13.tar.gz` preserva sources do laboratório, relatório verificado, logs e imagens selecionadas; não inclui ROM, BIOS, libs do jogo nem bundle wasm do jogo.

A versão inicial do protocolo de 600 frames tinha política drop-new (alguns frames nem chegavam a ser publicados). O teste de 1.800 e o longo de 10.800 usam o buffer triplo por exchange descrito neste plano. O run longo usa RAB; os dois primeiros runs do jogo usaram o worklet linear de prova de transporte. Não confundir os limites dessas versões experimentais.

Reprodução na worktree preservada, em bash:

```bash
cd /Volumes/SSD_1TB/www/fabio/gbarecomp-web-canvas
# Se websocket-client ainda não existir, instalar em venv e usar seu Python.
BASE=/Volumes/SSD_1TB/www/fabio/gbarecomp bash lab/web-canvas/build_host.sh game
bash lab/web-canvas/build_audio.sh  # substitui o worklet linear pelo RAB
bash lab/web-canvas/build_probe.sh
python3 packaging/web/serve.py lab/web-canvas 18081
```

Em outro terminal da mesma worktree:

```bash
python3 lab/web-canvas/test_host.py lab/web-canvas/results/recheck-host
python3 lab/web-canvas/test_transport.py
python3 lab/web-canvas/test_game.py 10800 lab/web-canvas/results/recheck-game10800
python3 lab/web-canvas/test_game.py 10800 lab/web-canvas/results/recheck-headless10800 --headless
python3 lab/web-canvas/verify_results.py  # verifica os diretórios históricos nomeados no script
```

Para testes novos, comparar também seus diretórios `recheck-*` ou atualizar explicitamente os nomes no verificador; não usar o PASS dos diretórios históricos como evidência de um novo build.

A execução desta investigação não criou commits nem publicou branches. Os sources de produção continuam por implementar e revisar segundo os gates acima.

## 21. Implementação entregue

Esta seção registra o que a implementação contém. Não declara os gates de §14/§15 aprovados: a validação em navegador, o clean build nativo e `ctest` ainda precisam ser executados sobre este commit.

| Área | Entrega |
|---|---|
| Seleção de backend | `GBARECOMP_WEB_HOST` (default OFF, exige Emscripten). SDL não é procurado em nenhum build Emscripten; runtime UI ImGui é rejeitado no wasm com mensagem. `runtime.cmake` recebe a seleção como `GBARECOMP_CORE_WEB_HOST` e aplica as flags de browser ao executável do jogo |
| ABI | `src/runtime/host_web_shared.h`: campos atômicos gerados por uma única lista X-macro, exportada ao JS como descritor JSON com nomes/offsets; magic, versão, tamanho e `static_assert` de layout |
| Vídeo | `host_window_web.cpp::present` aplica `ColorLut` ao slot próprio e troca `middle` por exchange; `host_web.js` adquire por exchange, valida metadados, copia para staging, `texImage2D` só em mudança de dimensão, filtros nearest/linear/sharp (FBO + `compute_sharp_prescale_factor` equivalente), layout por gcd, HiDPI, context loss/restore e reapresentação sem frame novo |
| Entrada | Teclado por `code`, gamepad `standard`, toque (`setTouch`), máscaras OR por dispositivo; limpeza em blur/visibility/focus; comandos `{seq,kind,arg}` em ring com overflow contado, consumidos um por `pump()`; configuração `keybinds.ini`/`config.ini [KeyMap]` com tabela explícita de scancodes SDL |
| Pausa | `service_host_pause` compartilhado pelo loop externo e pelo hook present-in-place; aba oculta é auto-pausa distinta da manual; retomar reseta pacer e época de áudio. Nativo continua reapresentando o último frame durante pausa |
| Áudio | Tags de taxa no ring de playback (`drain_sample_block`, `discard_playback`), sem mudar síntese nem formato de save-state; blocos `{count,rate,epoch}` no ring compartilhado; reset por request/ack; AudioWorklet com módulo DSP separado (`host_web_audio_dsp.cpp`, quatro bancos RAB pré-alocados, fim de segmento por duração); falha/timeout de áudio não derruba vídeo |
| Página | `index.html` + `bootstrap.js`: preflight (secure context, COOP/COEP, SAB, tail calls, WebGL), AudioContext criado no gesto antes de fetch, erros HTTP de assets, pausa/save/load/volume/filtro/fullscreen por gesto, stop, reinício por reload, exportação de diagnósticos, coverage, misses e saves do MEMFS |
| Cobertura honesta | wasm informa `self_heal_recompile=UNAVAILABLE ... NOT_STATIC`; banner de miss não promete healing em background |
| Build | `build_web.sh` com diretórios isolados e checagem de `CMakeCache`, gate `host_backend=web`, bundle do worklet, `manifest.json` com revisão, emcc e hashes |
| Testes | ctest nativo: `web_protocol_tests`, `web_audio_rate_tests`, `web_audio_dsp_tests`, `web_host_js_tests` (se `node` existir). Browser (manual, Chrome via CDP, `websocket-client`): `tests/web/build_probe.sh` + `test_host.py` + `test_failures.py` sobre o probe sintético; `test_game.py <frames> <out> [--headless] [--strict]` sobre um bundle de jogo |

Não incluído no commit: `docs/WEB_WASM_CANVAS_EVIDENCE_2026-09-13.tar.gz` (pacote binário de evidências do laboratório, preservado fora do repositório) e qualquer ROM/BIOS.

Pendências conhecidas: matriz Firefox/Safari, gamepad físico, escuta humana do áudio, teste de taxa variável com jogo real, `GBARECOMP_STRICT_STATIC=1` em corpus de cobertura completa e persistência de saves (IDBFS, fora deste escopo).
