# Контексты гостевых потоков и shared WASM

`runtime/runtime.c` поддерживает отдельные CPU, TEB, guest stacks и диагностику для потоков. Это C-основа для исполнения настоящих гостевых функций в Workers. Работоспособность всей игры и сетевой детерминизм этим не подтверждаются.

| Export | Назначение |
| --- | --- |
| `wc3_context_create(tid, stackBase, stackSize, tebBase)` | Создаёт native context и возвращает указатель на его `CPU`; `0` при недопустимых аргументах или нехватке памяти. |
| `wc3_context_init(cpu, tid, stackBase, stackSize, tebBase)` | Переинициализирует неисполняемый контекст; возвращает `1` при успехе. |
| `wc3_call_context(cpu, address, argc, args)` | Вызывает гостевую функцию на данном CPU, возвращает EAX и восстанавливает исходные регистры контекста. `args` — native pointer на массив `uint32_t`. |
| `wc3_context_set_budget(cpu, count)` | Задаёт отдельный лимит dispatch и обнуляет его счётчик. |
| `wc3_context_trace_pointer/count(cpu)` | Возвращает native pointer кольцевого trace из 128 адресов и число записей. |
| `wc3_context_error_pointer(cpu)` | Возвращает native pointer последней ошибки контекста. |
| `wc3_context_depth(cpu)` | Возвращает глубину вложенных guest calls перед потенциально прерываемым вызовом. |
| `wc3_context_recover(cpu, previousDepth)` | После host exception откатывает сохранённые CPU frames и active-context TLS до указанной глубины. |
| `wc3_context_thread_notify(cpu, reason)` | Вызывает DllMain с `2` — THREAD_ATTACH, `3` — THREAD_DETACH. |
| `wc3_disable_thread_calls(moduleBase)` | Отключает thread notifications для DLL; DLL со static TLS не принимаются. |
| `wc3_context_destroy(cpu)` | Освобождает native context **после остановки его Worker**. Guest stack/TEB освобождает broker. Главный контекст удалить нельзя. |

Guest stack должен быть размером не менее 4 KiB, с выровненным на 16 байт началом. TEB/TLS занимает 8 KiB, начало выровнено на 4 KiB. Оба диапазона должны быть доступны, находиться в guest memory и не пересекаться. Начальный ESP равен `align_down(stackBase + stackSize - 16, 16)`. TEB содержит StackBase, StackLimit, Self, ClientId, TLS pointer и общий PEB. Каждый контекст исполняется одним Worker; broker может вложенно вызвать callback на том же CPU только когда Worker ожидает ответ HLE.

Главные `wc3_call`, `wc3_cpu_pointer`, `wc3_trace_pointer/count` и `wc3_set_budget` сохранены. Диагностика и callback depth принадлежат контексту, а не общим глобальным переменным. Native TLS хранит указатель активного контекста для fault из memory helpers без параметра CPU. Guest heap bump allocator использует atomic compare/exchange.

Последовательность создания вторичного instance:

1. Broker выделяет native stack, TLS storage, context и массив аргументов. Native stack top выровнен на 16 байт; TLS storage имеет размер `__tls_size.value` и выравнивание `__tls_align.value`.
2. Worker инстанцирует тот же скомпилированный `WebAssembly.Module` с **той же** `env.memory`.
3. Worker устанавливает `exports.__stack_pointer.value = nativeStackTop`, затем вызывает `exports.__wasm_init_tls(nativeTlsBase)`.
4. После завершения общей PE initialization Worker вызывает THREAD_ATTACH, `wc3_call_context`, затем THREAD_DETACH при штатном выходе.
5. Если host exception прервал вызов, JavaScript сначала восстанавливает сохранённый `__stack_pointer.value`, затем вызывает `wc3_context_recover(cpu, previousDepth)`. Только после этого можно выполнять DLL_THREAD_DETACH. Каждый вложенный вызов сохраняет собственные depth и native stack pointer: callback broker не должен сбрасывать глубину внешнего Worker call до нуля.
6. После остановки Worker broker освобождает native context, stack, TLS и аргументы. Активный на данном instance контекст освободить нельзя.

Для исключений сохранены 128 frames на контекст, каждый содержит CPU и прежний указатель active-context TLS. JavaScript exception из WASM import пропускает C epilogues: без явного восстановления теряются guest ESP, callback depth и native linear stack pointer. C recovery восстанавливает guest/TLS состояние; native stack pointer возвращает JavaScript между вызовами exports. Это также исключает dangling active-context pointer после освобождения контекста.

`_initialize`, `wc3_init`, загрузка/link PE и DLL_PROCESS_ATTACH выполняются только в главном instance. Linker инициализирует shared static data один раз; отдельные TLS blocks и mutable stack pointers принадлежат instance. Это соответствует [WebAssembly linking conventions](https://github.com/WebAssembly/tool-conventions/blob/main/Linking.md). Политика HLE RPC, ожидания Win32 handles и жизненный цикл Workers реализуются в JavaScript broker.

Порядок DLL_THREAD_ATTACH сохраняет реальный порядок успешных DLL_PROCESS_ATTACH с учётом зависимостей. DETACH проходит его в обратном порядке. DisableThreadLibraryCalls хранит состояние по каждому модулю; возврат DllMain при thread notifications не влияет на успешность вызова. Динамическая загрузка/инициализация модулей должна сериализоваться broker; данная C API не добавляет отдельный Win32 loader lock.

Проверка без файлов Warcraft:

```sh
.venv/bin/python -m unittest tests.test_runtime_threads -v
```

Тест компилирует настоящие `cpu.c`, `pe.c`, `runtime.c` вместе с синтетическими guest entries и PE DLL. Два Node Workers синхронизируются атомарным барьером, выполняют 200 000 guest atomic increments и параллельные malloc/volatile-write/free. Проверяются изоляция native TLS/stack/CPU, вложенные callbacks, сохранение main-thread wrapper, отсутствие повторной shared data initialization и порядок DLL notifications с suppression. Настоящие host exceptions отдельно проверяют восстановление native stack, CPU побайтно, depth 2→1 для вложенного callback, возможность последующего DLL detach и отсутствие dangling active-context pointer.

`thread-rpc.mjs` поддерживает повторный вход в исходный Worker: ожидающий HLE-вызов может получить запрос callback, выполнить его на том же CPU/instance и сделать вложенный HLE-вызов через отдельный SharedArrayBuffer. `host.callAsync()` сохраняет CPU через асинхронное ожидание. Это нужно реальному Miles file callback: чтение MPQ ждёт отдельный поток Storm, пока внешний аудиовызов остаётся незавершённым. На браузерном пути этот механизм уже используется оригинальной музыкой меню.

`worker-fast.mjs` выполняет ограниченный список CRT-операций со строками, памятью и числами непосредственно в Worker текущего CPU, используя те же HLE-обработчики. Проверки адресов, cdecl/stdcall и x87 сохраняются. Там же исполняются TLS/last-error (общие ячейки), критические секции по выровненным адресам (атомарное слово `OwningThread`, ожидание через `Atomics.wait`) и `qsort` с компаратором гостя на том же CPU. Объекты Win32 (события, мьютексы, handles), выделение памяти, callbacks broker, файлы и звук проходят через broker; GL-вызовы идут асинхронным потоком команд (`graphics-batch.mjs`, см. [runtime-contract.md](runtime-contract.md)). Счётчики локальных вызовов передаются через SharedArrayBuffer и суммируются в отчёте; fault содержит имя импорта, аргументы и регистры. Broker посылает heartbeat активным RPC-ожиданиям, чтобы корректный бесконечный Win32 wait не принимался за потерянный Worker.
