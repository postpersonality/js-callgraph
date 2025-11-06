# План реализации контекстного именования callback-функций

## Исходная задача

Изменить именование анонимных функций, используемых как callback'и, с общего `anon` на контекстное имя вида `clb(someFn)` для функций-callback'ов. При наличии нескольких callback'ов в одном вызове использовать индексацию: `clb(someFn)[1]`, `clb(someFn)[2]`, и т.д.

### Текущее поведение

```javascript
someFn(1, 2, function() {
    console.log("I am a callback");
});

someFn(3, 4, () => {
    console.log("I am also a callback");
});
```

**Текущий вывод:**
- `global:anon[1]` - первая анонимная функция
- `global:anon[2]` - вторая анонимная функция

**Желаемый вывод:**
- `clb(someFn)` - первый callback к `someFn`
- `clb(someFn)` - второй callback к `someFn` (или если в одном вызове, то `clb(someFn)[1]`, `clb(someFn)[2]`)

## Анализ текущей реализации

### Существующая система нумерации (из plans/function-naming.md)

Уже реализована система нумерации анонимных функций:
- **Файл:** `src/astutil.js`
- **Функция `init()`** (строки 72-230):
  - Создает `Map` для отслеживания счетчиков анонимных функций
  - При обнаружении анонимной функции присваивает `nd.attr.anonIndex`
  - Счетчики ведутся отдельно для каждой родительской функции
- **Функция `funcname()`** (строки 246-271):
  - Использует `func.attr.anonIndex` для генерации имени вида `${parentName}:anon[${index}]`

### Ключевые компоненты для callback-именования

1. **Обнаружение контекста callback'а:**
   - Анонимная функция является callback'ом, если она передается как аргумент в `CallExpression`
   - `nd.attr.parent` указывает на родительский узел
   - `nd.attr.childProp` указывает на свойство родителя (например, `'arguments'`)
   - Если `parent.type === 'CallExpression'` и `childProp === 'arguments'`, то это callback

2. **Извлечение имени вызываемой функции:**
   - У `CallExpression` есть свойство `callee`
   - Для простого вызова: `someFn(...)` → `callee.type === 'Identifier'`, `callee.name === 'someFn'`
   - Для вызова метода: `obj.method(...)` → `callee.type === 'MemberExpression'`
   - Для цепочки: `obj.prop.method(...)` → нужно построить полное имя

3. **Определение индекса аргумента:**
   - `parent.arguments` - массив аргументов вызова
   - Нужно найти индекс текущей функции в этом массиве
   - Если в одном вызове несколько callback'ов (функций), нумеровать их

## Детальный план реализации

### Фаза 1: Добавление функции извлечения имени callee

**Файл:** `src/astutil.js`

Добавить новую вспомогательную функцию для извлечения имени вызываемой функции:

```javascript
/**
 * Извлекает имя вызываемой функции из CallExpression
 * @param {Object} callNode - узел CallExpression
 * @returns {string|null} - имя функции или null, если не удается определить
 */
function getCalleeName(callNode) {
    if (!callNode || callNode.type !== 'CallExpression') {
        return null;
    }
    
    const callee = callNode.callee;
    
    // Простой случай: someFn(...)
    if (callee.type === 'Identifier') {
        return callee.name;
    }
    
    // Вызов метода: obj.method(...)
    if (callee.type === 'MemberExpression') {
        // Построить полное имя: obj.prop.method
        return buildMemberExpressionName(callee);
    }
    
    // Другие случаи (например, IIFE): невозможно определить простое имя
    return null;
}

/**
 * Строит имя из цепочки MemberExpression
 * @param {Object} node - узел MemberExpression
 * @returns {string} - имя вида "obj.prop.method"
 */
function buildMemberExpressionName(node) {
    if (node.type === 'Identifier') {
        return node.name;
    }
    
    if (node.type === 'MemberExpression') {
        const objectName = buildMemberExpressionName(node.object);
        const propertyName = node.computed 
            ? '[computed]'  // для obj[expr]
            : node.property.name;
        return `${objectName}.${propertyName}`;
    }
    
    return 'unknown';
}
```

**Местоположение:** Добавить после функции `isAnon()` (примерно строка 244).

### Фаза 2: Обнаружение callback-контекста при инициализации

**Файл:** `src/astutil.js`, функция `init()`

Модифицировать логику обнаружения анонимных функций (строки 156-177):

```javascript
// Существующий код:
if (nd.type === 'FunctionDeclaration' ||
    nd.type === 'FunctionExpression' ||
    nd.type === 'ArrowFunctionExpression') {

    root.attr.functions.push(nd);
    nd.attr.parent = parent;
    nd.attr.childProp = childProp;
    
    // Check if function will be anonymous after all naming attempts
    let willBeAnonymous = false;
    if (nd.id === null) {
        let hasParentName = false;
        if (parent?.type === 'AssignmentExpression') {
            if (parent?.left?.type == 'Identifier') {
                hasParentName = true;
            }
        } else if (parent?.type == 'VariableDeclarator') {
            if (parent?.id?.type == 'Identifier') {
                hasParentName = true;
            }
        }
        willBeAnonymous = !hasParentName;
    }
    
    // НОВАЯ ЛОГИКА: Обнаружение callback-контекста
    if (willBeAnonymous) {
        // Проверить, является ли функция callback'ом
        const isCallback = (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') 
                          && childProp === 'arguments';
        
        if (isCallback) {
            // Сохранить информацию о callback-контексте
            nd.attr.isCallback = true;
            nd.attr.callbackCallNode = parent;  // сохранить ссылку на CallExpression
            
            // Найти индекс этой функции среди аргументов
            const argumentIndex = parent.arguments.indexOf(nd);
            nd.attr.callbackArgumentIndex = argumentIndex;
            
            // Подсчитать сколько функций передается в этот вызов (для нумерации)
            const functionArgsCount = parent.arguments.filter(arg => 
                arg.type === 'FunctionExpression' || 
                arg.type === 'ArrowFunctionExpression'
            ).length;
            nd.attr.callbackFunctionArgsCount = functionArgsCount;
            
            // Определить позицию среди функций-аргументов (не общих аргументов)
            let functionArgPosition = 0;
            for (let i = 0; i <= argumentIndex; i++) {
                const arg = parent.arguments[i];
                if (arg.type === 'FunctionExpression' || arg.type === 'ArrowFunctionExpression') {
                    functionArgPosition++;
                }
            }
            nd.attr.callbackFunctionPosition = functionArgPosition;
        } else {
            // Не callback - использовать существующую логику нумерации
            nd.attr.anonIndex = getNextAnonIndex(enclosingFunction);
        }
    }
    
    // ... остальной код
}
```

### Фаза 3: Модификация функции funcname()

**Файл:** `src/astutil.js`, функция `funcname()` (строки 246-271)

Изменить логику генерации имени для callback'ов:

```javascript
function funcname(func) {
    if (func === undefined) {
        console.log('WARNING: func undefined in astutil/funcname.');
    } else if (func.id === null) {
        const parent = func?.attr?.parent;
        
        // Попытка найти имя через родительские узлы
        if (parent?.type === 'AssignmentExpression') {
            if (parent?.left?.type == 'Identifier') {
                return parent.left.name;
            }
        } else if (parent?.type == 'VariableDeclarator') {
            if (parent?.id?.type == 'Identifier') {
                return parent.id.name;
            }
        }
        
        // НОВАЯ ЛОГИКА: Обработка callback'ов
        if (func.attr && func.attr.isCallback) {
            const callNode = func.attr.callbackCallNode;
            const calleeName = getCalleeName(callNode);
            
            if (calleeName) {
                const functionArgsCount = func.attr.callbackFunctionArgsCount;
                const functionPosition = func.attr.callbackFunctionPosition;
                
                // Если только один callback в вызове
                if (functionArgsCount === 1) {
                    return `clb(${calleeName})`;
                } else {
                    // Если несколько callback'ов, добавить индекс
                    return `clb(${calleeName})[${functionPosition}]`;
                }
            }
            // Если не удалось получить имя callee, fallback к обычной нумерации
        }
        
        // Существующая логика для обычных анонимных функций
        if (func.attr && typeof func.attr.anonIndex === 'number') {
            const encFunc = func.attr.enclosingFunction;
            const parentName = encFuncName(encFunc);
            return `${parentName}:anon[${func.attr.anonIndex}]`;
        }
        
        return "anon"; // fallback
    }
    return func.id.name;
}
```

### Фаза 4: Экспорт новых функций

**Файл:** `src/astutil.js`, раздел exports (строки ~440+)

Добавить экспорт новых вспомогательных функций:

```javascript
exports.getCalleeName = getCalleeName;
exports.buildMemberExpressionName = buildMemberExpressionName;
```

## Примеры ожидаемого поведения

### Пример 1: Единичный callback

```javascript
someFn(1, 2, function() {
    console.log("callback");
});
```

**Ожидаемое имя:** `clb(someFn)`

### Пример 2: Несколько callback'ов в одном вызове

```javascript
someFn(1, 2, function() {
    console.log("first");
}, () => {
    console.log("second");
});
```

**Ожидаемые имена:** 
- `clb(someFn)[1]` для первого callback'а
- `clb(someFn)[2]` для второго callback'а

### Пример 3: Callback к методу объекта

```javascript
Array.prototype.map.call([1,2,3], x => x * 2);
```

**Ожидаемое имя:** `clb(Array.prototype.map.call)`

### Пример 4: Множественные вызовы с callback'ами

```javascript
someFn(1, () => console.log("a"));
someFn(2, () => console.log("b"));
```

**Ожидаемые имена:** 
- `clb(someFn)` для первого callback'а
- `clb(someFn)` для второго callback'а

(Оба имеют одинаковое имя, но разные позиции в файле)

### Пример 5: Не-callback анонимная функция

```javascript
const standalone = function() {
    console.log("Not a callback");
};
```

**Ожидаемое имя:** `standalone` (имя из VariableDeclarator)

```javascript
function outer() {
    const inner = () => {};  // имя из VariableDeclarator
    (() => {})();  // IIFE - не callback
}
```

**Ожидаемое имя для IIFE:** `outer:anon[1]` (существующая логика нумерации)

### Пример 6: IIFE (Immediately Invoked Function Expression)

```javascript
(function() {
    console.log("IIFE");
})();
```

**Ожидаемое имя:** `global:anon[1]`

**Обоснование:** Хотя технически это CallExpression, но `callee` не является Identifier или MemberExpression (это сама FunctionExpression), поэтому `getCalleeName()` вернет `null`, и мы используем fallback к обычной нумерации.

## Граничные случаи и особенности

### 1. Вложенные callback'ы

```javascript
someFn(function outer() {
    anotherFn(function inner() {
        console.log("nested");
    });
});
```

**Ожидаемые имена:**
- `outer` - именованная функция
- `clb(anotherFn)` - callback к `anotherFn`

### 2. Callback с именем

```javascript
someFn(function namedCallback() {
    console.log("I have a name");
});
```

**Ожидаемое имя:** `namedCallback`

**Обоснование:** `func.id !== null`, поэтому вся логика для анонимных функций не применяется.

### 3. Callback, переданный через переменную

```javascript
const myFunc = () => console.log("x");
someFn(myFunc);
```

**Ожидаемое имя для `myFunc`:** `myFunc` (из VariableDeclarator)

**Обоснование:** При определении функция получает имя из VariableDeclarator. При передаче в `someFn` передается Identifier, а не FunctionExpression.

### 4. Computed property access

```javascript
obj[computedKey](function() {});
```

**Ожидаемое имя:** `clb(obj.[computed])`

### 5. Сложные выражения в callee

```javascript
(condition ? funcA : funcB)(function() {});
```

**Ожидаемое имя:** `global:anon[N]`

**Обоснование:** `callee` - это ConditionalExpression, `getCalleeName()` вернет `null`, используется fallback.

### 6. Callback в конструкторе

```javascript
new SomeClass(function() {});
```

**Ожидаемое имя:** `clb(SomeClass)`

**Обоснование:** `NewExpression` обрабатывается аналогично `CallExpression`.

### 7. Смешанные аргументы (не все функции)

```javascript
someFn(1, "string", function first() {}, 42, () => {});
```

**Ожидаемые имена:**
- `first` - именованная функция
- `clb(someFn)[1]` - для arrow function (это вторая функция среди аргументов)

**Важно:** Индекс считается только среди функций-аргументов, не среди всех аргументов.

## Тестирование

### Создание тестовых файлов

**Новый файл:** `tests/input/callbacks/single-callback.js`
```javascript
function someFn(a, b, callback) {
    callback();
}

someFn(1, 2, function() {
    console.log("callback");
});
```

**Новый файл:** `tests/input/callbacks/multiple-callbacks.js`
```javascript
function someFn(cb1, cb2) {
    cb1();
    cb2();
}

someFn(
    function() { console.log("first"); },
    () => { console.log("second"); }
);
```

**Новый файл:** `tests/input/callbacks/method-callback.js`
```javascript
[1, 2, 3].forEach(x => console.log(x));
Array.prototype.map.call([1, 2], x => x * 2);
```

**Новый файл:** `tests/input/callbacks/mixed-callbacks.js`
```javascript
function test(a, fn1, b, fn2) {}

test(
    1,
    function() {},
    "string",
    () => {}
);
```

### Эталонные выходы

Необходимо создать соответствующие `.truth` файлы в:
- `tests/reference/ONESHOT/callbacks/`
- `tests/reference/DEMAND/callbacks/`

### Обновление существующих тестов

Многие существующие тесты содержат callback'ы и их эталонные выходы нужно будет обновить:

1. **Native function callbacks:**
   - `tests/reference/*/basics/arrow-call.truth`
   - Любые тесты с Array methods (map, forEach, filter и т.д.)

2. **Проверить файлы:**
   ```bash
   # Найти все тесты с callback-паттернами
   rg "\(function" tests/input/ -l
   rg "=>\s*" tests/input/ -l
   ```

### Стратегия тестирования

1. **Запустить текущие тесты** для понимания baseline
2. **Внести изменения в код**
3. **Регенерировать эталоны:**
   ```bash
   npm test -- --updateSnapshot
   # или
   python3 tests/test.py --update-references
   ```
4. **Вручную проверить несколько ключевых тестов:**
   - Убедиться, что callback'ы получают правильные имена
   - Убедиться, что не-callback'ы не изменились
   - Проверить граничные случаи

## Потенциальные проблемы и решения

### Проблема 1: Производительность

**Потенциальная проблема:** 
- Фильтрация массива аргументов для подсчета функций выполняется для каждой анонимной callback-функции
- Для вызовов с большим количеством аргументов может быть неэффективно

**Решение:**
Подсчет можно кэшировать на уровне CallExpression:
```javascript
if (!parent.attr.functionArgsAnalyzed) {
    parent.attr.functionArgsCount = parent.arguments.filter(arg => 
        arg.type === 'FunctionExpression' || 
        arg.type === 'ArrowFunctionExpression'
    ).length;
    parent.attr.functionArgsAnalyzed = true;
}
```

### Проблема 2: Длинные имена для цепочек вызовов

**Потенциальная проблема:**
```javascript
obj.very.long.chain.of.properties.method(function() {});
```
Результат: `clb(obj.very.long.chain.of.properties.method)`

**Решение:**
Можно добавить опцию для ограничения глубины:
```javascript
function buildMemberExpressionName(node, maxDepth = 3) {
    // ... ограничить глубину рекурсии
}
```

Но для первой версии оставить без ограничений.

### Проблема 3: Конфликт с существующей нумерацией

**Потенциальная проблема:**
Что если в коде есть смесь callback'ов и обычных анонимных функций?

```javascript
function outer() {
    const f1 = () => {};      // outer:anon[1]
    someFn(() => {});         // clb(someFn)
    const f2 = function() {}; // outer:anon[2] или outer:anon[3]?
}
```

**Решение:**
Callback'ы НЕ увеличивают `anonIndex` счетчик, так как для них не вызывается `getNextAnonIndex()`. Таким образом:
- `f1` → `outer:anon[1]`
- callback → `clb(someFn)`
- `f2` → `outer:anon[2]`

### Проблема 4: Детерминированность

**Потенциальная проблема:**
Порядок обхода AST должен быть стабильным для воспроизводимых результатов.

**Решение:**
Текущая реализация `visit()` обходит дерево в предсказуемом порядке (depth-first, слева направо). Это гарантирует детерминированность.

## Альтернативные варианты дизайна

### Вариант 1: Использовать имя параметра вместо индекса

```javascript
function someFn(callback1, callback2) {}
someFn(() => {}, () => {});
```

**Возможный результат:** `clb(someFn.callback1)`, `clb(someFn.callback2)`

**Проблема:** 
- Требует разрешения связи между вызовом и определением функции
- Не всегда возможно (динамические вызовы, внешние библиотеки)
- Сложнее реализовать

**Решение:** Оставить для будущих версий.

### Вариант 2: Использовать позицию аргумента (не только функций)

```javascript
someFn(1, 2, () => {}, "str", () => {});
```

**Текущий дизайн:** `clb(someFn)[1]`, `clb(someFn)[2]` (позиция среди функций)

**Альтернатива:** `clb(someFn)[3]`, `clb(someFn)[5]` (позиция среди всех аргументов)

**Обоснование выбора текущего дизайна:**
- Меньше путаницы (индекс 1 = первая функция)
- Не зависит от нефункциональных аргументов

### Вариант 3: Более короткое имя

**Текущий дизайн:** `clb(someFn)`

**Альтернативы:**
- `someFn$cb`
- `someFn_callback`
- `@someFn`

**Обоснование выбора `clb()`:**
- Ясно указывает на callback
- Синтаксис похож на вызов функции
- Согласуется с форматом запроса пользователя

## План внедрения

### Этап 1: Подготовка (только чтение и анализ)
- [x] Анализ текущей кодовой базы
- [x] Создание плана реализации
- [x] Определение граничных случаев

### Этап 2: Реализация core-функциональности
- [ ] Добавить `getCalleeName()` и `buildMemberExpressionName()`
- [ ] Модифицировать `init()` для обнаружения callback-контекста
- [ ] Модифицировать `funcname()` для генерации callback-имен
- [ ] Добавить экспорты новых функций

### Этап 3: Тестирование
- [ ] Создать новые тестовые файлы в `tests/input/callbacks/`
- [ ] Запустить существующие тесты
- [ ] Обновить эталонные выходы
- [ ] Проверить граничные случаи вручную

### Этап 4: Оптимизация
- [ ] Кэширование подсчета функций-аргументов
- [ ] Проверка производительности на больших файлах

### Этап 5: Документация
- [ ] Обновить README.md с примерами callback-именования
- [ ] Добавить комментарии к новым функциям
- [ ] Обновить AGENTS.md документацию

## Обратная совместимость

**ВАЖНО:** Это breaking change!

Текущие пользователи, парсящие вывод инструмента, увидят изменение имен функций:
- Было: `global:anon[1]`, `global:anon[2]`
- Стало: `clb(someFn)[1]`, `clb(someFn)[2]`

### Возможные решения для обратной совместимости:

1. **Опция командной строки** (рекомендуется для будущего):
   ```bash
   jscg --cg file.js --callback-naming=context  # новое поведение
   jscg --cg file.js --callback-naming=legacy   # старое поведение
   ```

2. **Версионирование формата вывода:**
   ```json
   {
     "formatVersion": "2.3.0",
     "edges": [...]
   }
   ```

3. **Переходный период:**
   - Выпустить как major версию (3.0.0)
   - Добавить предупреждение в CHANGELOG

Для первой версии реализации можно внедрить сразу, без опций (breaking change в major версии).

## Ожидаемые результаты

После реализации:

1. **Улучшенная читаемость:**
   - `clb(Array.prototype.map)` вместо `global:anon[5]`
   - Сразу видно, к какой функции относится callback

2. **Лучшая отладка:**
   - Легче найти конкретный callback в коде
   - Имя указывает на контекст использования

3. **Сохранение существующей функциональности:**
   - Именованные функции не изменяются
   - Функции с именем из VariableDeclarator не изменяются
   - IIFE и другие не-callback'и используют старую нумерацию

4. **Детерминированность:**
   - Одинаковый вывод при повторных запусках
   - Стабильные имена для одинаковых конструкций

---

**Дата создания плана:** 2025-11-06  
**Статус:** Готово к реализации  
**Приоритет:** Средний  
**Сложность:** Средняя  
**Estimated effort:** 4-6 часов для реализации + 2-3 часа для тестирования
