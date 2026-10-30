# TU CUMPA — CNXieku

Actor JavaScript: una ficha por URL o una búsqueda por palabra/código. Usa Apify
SDK y Cheerio de la dependencia Crawlee ya instalada. No recorre el catálogo,
no descarga imágenes ni fichas de los candidatos y no usa navegadores o proxies.

## Instalación y acceso

Node.js 24 y Apify CLI. En una instalación nueva: `npm ci`. Producto y búsqueda
intentan HTTP real por defecto:

```powershell
apify run --no-purge --input-file input.product.json
```

El Actor de Cloud arranca con `node src/main.js` y no necesita `.env.local` ni
credenciales del sitio. `.actorignore` limita el despliegue al código y los
archivos necesarios para el build, excluyendo credenciales, diagnósticos y
almacenamiento local. Los errores identifican DNS, TCP, TLS, HTTP o timeout.

## Ejecución

### Ejecutar desde Zed

Abrir `C:\Users\USUARIO\Desktop\scrapernuevo` como carpeta del proyecto en Zed.
Editar `storage/key_value_stores/default/INPUT.json` para elegir `mode: "product"`
o `mode: "search"`, con los campos del ejemplo correspondiente de abajo.
Abrir la paleta con **Ctrl+Shift+P**, elegir **task: spawn**, seleccionar
**Ejecutar CNXieku** y pulsar **Enter**. Para repetir, usar **task: rerun**
en la misma paleta o el control de repeticion de la terminal de la tarea.

La tarea `.zed/tasks.json` guarda los archivos abiertos y ejecuta
`node --env-file=.env.local src/main.js` desde la raiz del proyecto.
`.env.local` es solo para configuracion local y sigue excluido del despliegue.
La tarea fija el almacenamiento local en `./storage`, el INPUT y los
almacenes `default`, desactiva la purga y deja vacios `APIFY_IS_AT_HOME` y
`APIFY_TOKEN` para mantener el modo local. No hace falta ejecutar Apify CLI.

Los mensajes aparecen en la terminal de la tarea. El resultado local está en
`storage/key_value_stores/cnxieku-results/RESULT.json`. Se reemplaza con cada
resultado válido; no se agregan archivos numerados. Los diagnósticos del run
quedan en `storage/key_value_stores/default/`.

Como alternativa por terminal:

```powershell
apify run --no-purge --input-file input.product.json
apify run --no-purge --input-file input.search.json
```

Ficha: `{"mode":"product","url":"https://www.cnxieku.com/item/20354","outputFormat":"reference1688"}`.
Búsqueda: `{"mode":"search","source":"cnxieku","query":"1937","maxResults":10}`.
Cambiar query por una palabra china u otro código. maxResults usa 10 por defecto,
máximo 20. La búsqueda devuelve candidatos; elegir una URL requiere otro run product.
No mezclar los campos de ambas operaciones. La URL de ficha no lleva query o fragmento.

En el formulario de Apify, seleccionar **Operación** y completar solo su sección:
`product` usa **URL del producto** y **Formato de la ficha**; `search` usa
**Palabra o código**, **Máximo de candidatos** opcional y formato `canonical`.
Dejar vacíos los campos del otro modo. Los campos vacíos se omiten antes de
validar; los campos incompatibles con contenido producen `INVALID_INPUT` sin HTTP.
El formulario admite selector y secciones, sin ocultación condicional documentada;
no se usan `showIf` ni reglas incompatibles con el
[esquema de entrada de Apify](https://docs.apify.com/actors/development/actor-definition/input-schema/specification/v1).

`reference1688` conserva once campos: url, title, price, productLadderPrices, moq,
weight, dimensions, images, characteristics, variations y productId. El formato
canonical conserva estado, producto y campos faltantes. La búsqueda tiene un
contrato de lista propio. No se inventan moneda, valores ausentes ni imágenes de SKU.

## Resultado persistente

El Key-Value Store nombrado **`cnxieku-results`**, registro **`RESULT`**, conserva
un único resultado lógico entre runs. No se escriben productos en el dataset.
La estructura común es:

```json
{
  "schemaVersion": 1,
  "source": "cnxieku",
  "mode": "product",
  "outputFormat": "reference1688",
  "status": "success",
  "updatedAt": "2026-10-30T12:00:00.000Z",
  "runId": "ID_DEL_RUN",
  "data": {}
}
```

`data` contiene la ficha canonical completa, los once campos 1688 sin cambios,
o la respuesta de búsqueda con `results`, según `mode` y `outputFormat`.
`success` y `partial` reemplazan RESULT; una búsqueda válida sin candidatos
también lo reemplaza. Errores de entrada, red, bloqueo o análisis conservan el
último válido. Sin uno previo, RESULT aún no existe. `LAST_ERROR`, `RUN_STATE`
y `TIMINGS` son diagnósticos de cada run, y los fallos terminan con exit 1.

En Apify: **Storage → Key-value stores → cnxieku-results → RESULT**.
La salida del run **RESULT persistente** abre `RESULT_LOCATION`, con `apiUrl`
para leer el JSON actual y `consoleUrl` para abrir el almacén. Se guarda solo
la referencia por run, sin duplicar el producto. La API estable es
`https://api.apify.com/v2/key-value-stores/<STORE_ID>/records/RESULT`;
el almacén mantiene sus permisos privados habituales.

Una cola nombrada `cnxieku-results-writer`, con una sola solicitud de control,
proporciona el bloqueo exclusivo en Cloud. Si otro run lo posee, la ejecución
termina con `RESULT_BUSY`, sin HTTP ni cambios en RESULT. El bloqueo dura 300 s,
se renueva antes de publicar y se libera al terminar o abortar; tras una caída
expira automáticamente. Las escrituras tienen timeout de 15 s y no se reintentan.
Localmente se usa un archivo de bloqueo exclusivo en `storage/`; si el proceso
es terminado a la fuerza, quitarlo solo tras comprobar que no queda un run activo.

Los tiempos excluyen init/exit del SDK y persistencia de diagnósticos. El CLI
puede sustituir INPUT: respaldarlo si contiene configuración que se necesita.

Límites: una solicitud por ficha, dos por búsqueda; cero redirecciones/reintentos;
plazo total predeterminado 30 s (1–60), máximo 2 MiB por respuesta. Se validan URL,
DNS público, IP remota y TLS. CAPTCHA, 403 y 429 detienen la operación. Un cambio de
estructura Nuxt/API produce un error explícito, no resultados inventados.

## Comprobación y Docker

`npm run check`, `npm test`, `npm run lint` y `apify validate-schema`.
Las pruebas locales son pequeñas y no hacen consultas públicas ni purgan datos.

```powershell
docker build --tag tucumpa-cnxieku:simple .
```

El contenedor ejecuta `node src/main.js`. Ejemplo local; cambiar el archivo
de entrada para probar búsqueda:

```powershell
$store = Join-Path (Get-Location).Path ('storage/docker-' + [guid]::NewGuid().ToString('N'))
$kv = Join-Path $store 'key_value_stores/default'
New-Item -ItemType Directory -Path $kv -Force | Out-Null
Copy-Item input.product.json (Join-Path $kv 'INPUT.json')
docker run --rm --env APIFY_IS_AT_HOME= --env APIFY_TOKEN= --env CRAWLEE_STORAGE_DIR=/usr/src/app/storage --mount "type=bind,source=$store,target=/usr/src/app/storage" tucumpa-cnxieku:simple
```

APIFY_IS_AT_HOME y APIFY_TOKEN quedan vacíos; el primero no debe ser `0` porque
el SDK interpreta cualquier cadena no vacía como modo plataforma. El nuevo
Dockerfile se comprobó estáticamente; no se reconstruyó una imagen en esta adaptación.

La extracción real de esta versión debe confirmarse en un run de Apify Cloud
revisando el producto en `cnxieku-results/RESULT`, además del estado del run.

Back Market permanece en el proyecto original y no se incorpora en esta adaptación.
El despliegue en Apify se prepara conectando GitHub desde Console. Se conserva la licencia ISC y el identificador de plantilla
Apify. Las dependencias de la plantilla se mantienen sin cambios de versiones;
la cadena transitiva basic-ftp previamente reportada requiere revisión de seguridad
antes de producción. El código consulta datos reales y no incluye resultados precargados.
