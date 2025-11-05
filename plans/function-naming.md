# План реализации улучшенного именования анонимных функций

## Текущая проблема

Сейчас все анонимные функции получают имя `"anon"` без различения. Например:
```javascript
function outer() {
    const a = () => {};      // "anon"
    const b = function() {}; // "anon"  
    (function() {})();       // "anon"
}
```

В выводе все три функции будут иметь label `"anon"`, что делает их неразличимыми.

## Целевое решение

Нумеровать анонимные функции в контексте их родительской функции:
- `outer:anon[1]` для первой анонимной функции внутри `outer`
- `outer:anon[2]` для второй анонимной функции внутри `outer`
- `outer:anon[3]` для третьей анонимной функции внутри `outer`

Для глобального уровня:
- `global:anon[1]`, `global:anon[2]`, и т.д.

## Алгоритм реализации

### Фаза 1: Добавление счетчиков (в `init()` функции)

1. **Создать Map для отслеживания счетчиков** на уровне каждой функции:
   - Ключ: AST-узел родительской функции (или `'global'` для глобального уровня)
   - Значение: счетчик анонимных функций

2. **Во время обхода AST**:
   - При обнаружении функции (FunctionExpression, FunctionDeclaration, ArrowFunctionExpression)
   - Проверить, является ли функция анонимной (после всех попыток найти имя)
   - Если анонимная:
     - Получить `enclosingFunction` из контекста обхода
     - Увеличить счетчик для этой родительской функции
     - Сохранить номер в атрибуте функции: `nd.attr.anonIndex = N`

3. **Сохранить счетчик в атрибуты узла**:
   - `func.attr.anonIndex` - номер анонимной функции в родителе

### Фаза 2: Модификация `funcname()`

Изменить логику в `funcname()` (строки 209-226 в astutil.js):

```javascript
function funcname(func) {
    if (func === undefined) {
        console.log('WARNING: func undefined in astutil/funcname.');
        return "unknown";
    }
    
    if (func.id === null) {
        // Попытки найти имя через родительские узлы (существующая логика)
        const parent = func?.attr?.parent;
        if (parent?.type === 'AssignmentExpression') {
            if(parent?.left?.type == 'Identifier') {
                return parent.left.name;
            }
        } else if (parent?.type == 'VariableDeclarator') {
            if(parent?.id?.type == 'Identifier') {
                return parent.id.name;
            }
        }
        
        // НОВАЯ ЛОГИКА: Если все еще анонимная, использовать нумерацию
        if (func.attr && typeof func.attr.anonIndex === 'number') {
            const encFunc = func.attr.enclosingFunction;
            const parentName = encFuncName(encFunc); // возвращает имя родителя или "global"
            return `${parentName}:anon[${func.attr.anonIndex}]`;
        }
        
        return "anon"; // fallback для старого поведения
    }
    
    return func.id.name;
}
```

### Фаза 3: Граничные случаи

1. **Глобальные анонимные функции**: 
   - `enclosingFunction` будет `null` или `undefined`
   - `encFuncName(null)` уже возвращает `"global"`
   - Результат: `"global:anon[1]"`, `"global:anon[2]"`, и т.д.

2. **Вложенные анонимные функции**:
   ```javascript
   function outer() {
       const f1 = function() {    // outer:anon[1]
           const f2 = () => {};   // outer:anon[1]:anon[1]
       };
   }
   ```
   - Счетчики ведутся отдельно для каждого уровня
   - Рекурсивная структура имен

3. **Именованные функции остаются неизменными**:
   - `function foo() {}` → `"foo"`
   - `const bar = function baz() {}` → `"baz"`

## Подробный план изменения кода

### Файл: `src/astutil.js`

**Изменение 1: Модификация функции `init()` (строки 72-190)**

Добавить перед основным обходом:
```javascript
// Map для отслеживания счетчиков анонимных функций
// Ключ: enclosingFunction (или 'global'), Значение: счетчик
const anonCounters = new Map();

function getNextAnonIndex(encFunc) {
    const key = encFunc || 'global';
    const current = anonCounters.get(key) || 0;
    const next = current + 1;
    anonCounters.set(key, next);
    return next;
}
```

Добавить логику после обнаружения функции в visit callback (примерно после строки 175):
```javascript
// После обработки всех специальных случаев именования
// и перед добавлением в root.attr.functions
if (isFunctionNode(nd)) {
    // Проверяем, осталась ли функция анонимной
    // после всех попыток найти имя
    const willBeAnonymous = (nd.id === null);
    
    if (willBeAnonymous) {
        nd.attr.anonIndex = getNextAnonIndex(enclosingFunction);
    }
}
```

**Изменение 2: Модификация функции `funcname()` (строки 209-226)**

Заменить строку 223 (`return "anon";`) на:
```javascript
// Если функция имеет индекс анонимной функции, использовать его
if (func.attr && typeof func.attr.anonIndex === 'number') {
    const encFunc = func.attr.enclosingFunction;
    const parentName = encFuncName(encFunc);
    return `${parentName}:anon[${func.attr.anonIndex}]`;
}

return "anon"; // fallback
```

## Тестирование

### Файлы для обновления:

1. **tests/reference/ONESHOT/step/inline-functions.truth**:
   - 3 анонимные функции станут: `global:anon[1]`, `global:anon[2]`, `global:anon[3]`

2. **tests/reference/DEMAND/step/inline-functions.truth**:
   - Аналогично ONESHOT

3. Другие файлы с анонимными функциями:
   - `tests/reference/*/basics/arrow-call.truth`
   - `tests/reference/*/basics/const-arrow.truth`
   - И многие другие

### Стратегия тестирования:

1. Запустить тесты с текущими эталонами, чтобы понять масштаб изменений
2. Сгенерировать новые эталонные выходы для всех тестов
3. Вручную проверить несколько ключевых тестов на корректность
4. Убедиться, что именованные функции не изменились
5. Проверить граничные случаи

## Риски и соображения

1. **Обратная совместимость**: Это breaking change для инструментов, парсящих вывод
   - Возможно, стоит добавить опцию командной строки `--legacy-anon-names`

2. **Производительность**: Map для счетчиков добавляет минимальные накладные расходы

3. **Детерминированность**: Порядок обхода AST должен быть стабильным для воспроизводимых результатов
   - В текущей реализации используется `visit()`, который обходит дерево в предсказуемом порядке

4. **Длинные имена**: Для глубоко вложенных анонимных функций имена могут стать очень длинными
   - `outer:anon[1]:anon[2]:anon[3]:anon[1]`
   - Это корректно, но может быть громоздко

## Альтернативные подходы (не рекомендуются)

1. **Использование позиции в файле**: `anon@line:column`
   - Проще, но менее понятно
   - Не показывает контекст

2. **Глобальная нумерация**: `anon[1]`, `anon[2]` для всего файла
   - Проще реализовать
   - Но теряется информация о родительском контексте

3. **Хеш от позиции**: `anon_a3f2b1`
   - Уникально, но совершенно нечитаемо

---

Текущий план предлагает наиболее информативный и понятный подход с разумной сложностью реализации.
