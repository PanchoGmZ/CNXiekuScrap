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

Los mensajes aparecen en la terminal de la tarea. Para abrir el resultado,
usar **Ctrl+P** y escribir `storage/datasets/default/000000001.json` para la
primera ejecucion. Las siguientes agregan JSON numerados en esa misma carpeta;
abrir el de numero mas alto. Si Ctrl+P no muestra archivos de `storage/` por
estar ignorados, usar **Ctrl+O** y pegar la ruta absoluta del JSON.
Cada ejecucion guarda un registro; consultar tambien `RUN_STATE.json` en
`storage/key_value_stores/default/` para comprobar el estado real del resultado.

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

`reference1688` conserva once campos: url, title, price, productLadderPrices, moq,
weight, dimensions, images, characteristics, variations y productId. El formato
canonical conserva estado, producto y campos faltantes. La búsqueda tiene un
contrato de lista propio. No se inventan moneda, valores ausentes ni imágenes de SKU.

Los resultados están en `storage/datasets/default/`; RUN_STATE y TIMINGS en
`storage/key_value_stores/default/`. El total excluye init/exit del SDK y escritura
de esos informes. Cada run guarda un registro; --no-purge conserva los anteriores.
El CLI puede sustituir INPUT: respaldarlo si contiene una configuración que se necesita.
Un exit 0 puede acompañar un error de negocio: consultar status/RUN_STATE y HTTP.

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
revisando el producto guardado en el dataset, no solo el estado del run.

Back Market permanece en el proyecto original y no se incorpora en esta adaptación.
No hay despliegue ni push. Se conserva la licencia ISC y el identificador de plantilla
Apify. Las dependencias de la plantilla se mantienen sin cambios de versiones;
la cadena transitiva basic-ftp previamente reportada requiere revisión de seguridad
antes de producción. El código consulta datos reales y no incluye resultados precargados.
