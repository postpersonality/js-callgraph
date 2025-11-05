# План реализации поддержки Step() функций

## Задача

Добавить поддержку Step-функций в js-callgraph. В call graph должна попадать цепочка вызовов коллбеков внутри Step().

## Анализ

### Что такое Step()

Step() - это библиотека управления потоком выполнения для Node.js. Она принимает последовательность функций и выполняет их по порядку:

```javascript
Step(
    function step1() {
        // первый шаг
        this();
    },
    function step2(err, result) {
        // второй шаг
        this();
    },
    function step3(err, result) {
        // третий шаг
    }
);
```

### Упрощённая модель

**Ключевое требование:** Функции внутри Step() обрабатываются **последовательно** и вызывают друг друга **ВСЕГДА**, независимо от наличия явных вызовов API (this(), this.parallel(), group()).

**Это означает:**
- Не нужно анализировать внутренности функций
- Не нужно искать вызовы this() или this.parallel()
- Просто создаём последовательную цепочку: step1 → step2 → step3 → ...

### Как это должно работать

Для вызова:
```javascript
Step(func1, func2, func3);
```

В call graph должны попасть рёбра:
```
caller → func1
func1 → func2
func2 → func3
```

## Реализация

### Подход

Создать специальную обработку для Step() в `src/natives.js`, которая:

1. Находит все вызовы Step()
2. Извлекает все функции-аргументы
3. Создаёт последовательные рёбра между ними через flow graph

### Архитектура

```
CallExpression(Step, [func1, func2, func3])
    ↓
isStepCall() → true
    ↓
handleStepCall()
    ↓
Создать рёбра:
- funcVertex(func1) → calleeVertex(dummyCall1→func2)
- funcVertex(func2) → calleeVertex(dummyCall2→func3)
- funcVertex(func1) → calleeVertex(originalStepCall)  // первый вызов
```

### Детали реализации

#### 1. Детектирование Step() вызовов

```javascript
function isStepCall(call) {
    return call.callee.type === 'Identifier' && 
           call.callee.name === 'Step';
}
```

#### 2. Обработка Step() вызовов

```javascript
function handleStepCall(call, flow_graph) {
    const flowgraph = require('./flowgraph');
    
    // Получить все функции-аргументы
    const steps = call.arguments.filter(arg => 
        arg.type === 'FunctionExpression' || 
        arg.type === 'ArrowFunctionExpression' ||
        arg.type === 'Identifier'  // ссылка на функцию
    );
    
    if (steps.length === 0) return;
    
    // Первый шаг вызывается из контекста Step()
    flow_graph.addEdge(
        flowgraph.funcVertex(steps[0]),
        flowgraph.calleeVertex(call)
    );
    
    // Последовательно связать каждый шаг со следующим
    for (let i = 0; i < steps.length - 1; i++) {
        const currentStep = steps[i];
        const nextStep = steps[i + 1];
        
        // Создать псевдо-вызов для связи
        const pseudoCall = {
            type: 'CallExpression',
            callee: nextStep,
            arguments: [],
            attr: {}
        };
        
        flow_graph.addEdge(
            flowgraph.funcVertex(currentStep),
            flowgraph.calleeVertex(pseudoCall)
        );
        
        flow_graph.addEdge(
            flowgraph.funcVertex(nextStep),
            flowgraph.calleeVertex(pseudoCall)
        );
    }
}
```

#### 3. Интеграция в pipeline

В `src/pessimistic.js` и `src/semioptimistic.js`:

```javascript
function buildCallGraph(ast, noOneShot) {
    const fg = new graph.FlowGraph();
    natives.addNativeFlowEdges(fg);
    natives.addStepFlowEdges(ast, fg);  // ← ДОБАВИТЬ
    // ... остальной код
}
```

## Тестирование

### Тест 1: Базовый (с именованными функциями)

**Файл:** `tests/input/step/basic-step.js`

```javascript
function step1() {
    console.log('Step 1');
}

function step2() {
    console.log('Step 2');
}

function step3() {
    console.log('Step 3');
}

Step(step1, step2, step3);
```

**Ожидаемый результат:** `tests/reference/DEMAND/step/basic-step.truth`

```
basic-step.js:global -> basic-step.js:step1
basic-step.js:step1 -> basic-step.js:step2
basic-step.js:step2 -> basic-step.js:step3
```

### Тест 2: Inline функции

**Файл:** `tests/input/step/inline-step.js`

```javascript
function doSomething() {
    console.log('do');
}

function processResult() {
    console.log('process');
}

Step(
    function first() {
        doSomething();
    },
    function second() {
        processResult();
    }
);
```

**Ожидаемый результат:** `tests/reference/DEMAND/step/inline-step.truth`

```
inline-step.js:global -> inline-step.js:first
inline-step.js:first -> inline-step.js:doSomething
inline-step.js:first -> inline-step.js:second
inline-step.js:second -> inline-step.js:processResult
```

### Тест 3: Реальный пример из Step-code-example.md

**Файл:** `tests/input/step/real-example.js`

Упрощённая версия реального кода с вызовами функций внутри шагов.

## План работы

- [ ] **Задача 1:** Добавить Step в список нативных функций (harness.js)
- [ ] **Задача 2:** Реализовать addStepFlowEdges() в natives.js
- [ ] **Задача 3:** Интегрировать в pessimistic.js
- [ ] **Задача 4:** Интегрировать в semioptimistic.js
- [ ] **Задача 5:** Создать тестовые файлы
- [ ] **Задача 6:** Создать reference файлы (.truth)
- [ ] **Задача 7:** Запустить тесты и верифицировать результаты

## Файлы для изменения

1. ✏️ `src/harness.js` - добавить "Step": "Step"
2. ✏️ `src/natives.js` - добавить addStepFlowEdges(), isStepCall(), handleStepCall()
3. ✏️ `src/pessimistic.js` - вызвать addStepFlowEdges()
4. ✏️ `src/semioptimistic.js` - вызвать addStepFlowEdges()
5. ➕ `tests/input/step/` - новая директория с тестами
6. ➕ `tests/reference/DEMAND/step/` - ожидаемые результаты
7. ➕ `tests/reference/ONESHOT/step/` - ожидаемые результаты

## Ограничения и допущения

1. **Только прямые вызовы Step()** - не обрабатываем Step.apply(), Step.call()
2. **Простая последовательность** - не моделируем параллельное выполнение
3. **Не обрабатываем передачу параметров** между шагами
4. **Не моделируем обработку ошибок** (err параметр)

Эти ограничения приемлемы, так как основная задача - показать цепочку вызовов в call graph.

## Критерии успеха

✅ Step() распознаётся как вызов функции  
✅ Все функции-аргументы Step() попадают в call graph  
✅ Последовательность вызовов step1 → step2 → step3 корректно отражена  
✅ Тесты проходят успешно
