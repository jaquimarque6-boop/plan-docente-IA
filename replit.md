# PlanDocente IA

Herramienta institucional web para docentes de nivel primario argentino. Sistema completo de gestión docente con generador de planificaciones, registros de clase, informes y actividad reciente.

## Stack
- **Backend**: Node.js + Express 5 (`server.js`)
- **Base de datos**: PostgreSQL (Replit built-in) — usuarios y sesiones
- **Frontend**: HTML5 + CSS3 + Vanilla JavaScript (`index.html`)
- **Auth**: express-session (sesiones en PostgreSQL vía connect-pg-simple) — login real por email+contraseña
- **Passwords**: bcryptjs (hash + salt)
- **Persistencia de contenido**: localStorage (planificaciones, alumnos, cursos, etc.)
- **PDF export**: Ventana de impresión nativa del navegador (`_abrirVentanaImpresion`)
- **Puerto**: 5000
- **IA**: OpenAI vía Replit AI Integrations (`AI_INTEGRATIONS_OPENAI_API_KEY` / `AI_INTEGRATIONS_OPENAI_BASE_URL`) — modelo `gpt-5-mini`

## Sistema de usuarios
- **Admin seed**: `admin@plandocenteia.com` / `Admin1234` (rol: admin)
- **Roles**: `admin` (panel gestión), `docente` (acceso normal)
- **Login screen**: pantalla propia con campos email + contraseña, diseño responsive mobile
- **Session**: `fetch('/api/me')` al cargar — redirige al admin panel si rol=admin, a planificaciones si docente
- **Logout**: `logoutUsuario()` → `POST /api/logout` → muestra pantalla de login

## Integración IA (POST /api/generar-material)
Endpoint protegido por `requireAuth`. Genera material educativo con OpenAI como primera opción; el frontend cae al generador local si la IA falla.

| Tipo | Input | Output |
|---|---|---|
| `ficha` | tema, materia, grado, nivel, indicaciones | `{actividades: [{tipo, consigna, items/texto/preguntas/lineas}]}` |
| `plan` | tema, materia, grado | `{obj, inicio, act1, act2, cierre, evaluacion}` |

**Frontend (index.html)**:
- `generarMaterialConIA(datos)` — helper async que llama a `/api/generar-material`
- `_actividadesDesdeIA(actividades)` — convierte JSON de IA a formato `{c, b}` del renderizador de fichas
- `generarFichaAlumno()` — async; intenta IA primero, fallback a `_buildFichaHTML()`
- `generarAsistente()` — async; intenta IA para la planificación, fallback a `_buildAsistentePlan()`

**Reglas**: No tocar login, usuarios, DB. Los generadores locales deben permanecer intactos como fallback.

## Planificación Avanzada (módulo principal)
Generador determinístico completo para todos los grados (primaria y secundaria). **Sin IA — 100% determinístico.**

**Posición en UI**: Aparece PRIMERO en la página de planificaciones, antes del Asistente Rápido.

**Estructura del output (10 secciones)**:
1. Fundamentación
2. Objetivos generales
3. Contenidos
4. Metas de aprendizaje
5. Indicadores de logro
6. Capacidades fundamentales
7. Evaluación — criterios generales
8. Secuencia didáctica (N clases)
9. Recursos
10. Bibliografía y recursos docentes

**Por clase**: Cada clase incluye Objetivo específico / Inicio / Desarrollo / Cierre / Evaluación / Continuidad.

**Editabilidad**: Todos los campos de texto tienen `contenteditable="true"` — el docente puede editar antes de imprimir.

**Multi-clase real**: La auto-ruta a `generarClasePrimaria` fue eliminada. Para `tipoSalida === 'planificacion'`, todos los grados van al generador avanzado. `buildClass(num, ...)` retorna `""` si `num > _maxClases`.

**Secuencias específicas**:
- Fracciones, multiplicación, cuento, sistema solar, entre otros (10 clases cada una)
- **Día del Trabajador** / **Revolución de Mayo** / **Independencia 9 de julio** (detección automática por keywords, 3 clases)
- Fallback: `generarSecuenciaPrincipal()` — genera secuencia genérica adaptada por materia y nivel

## Sistema de usuarios (multi-user con backend real)
Acceso administrado: solo el admin puede crear cuentas docentes. No hay auto-registro.

| Aspecto | Detalle |
|---|---|
| Auth | Email + contraseña verificada contra PostgreSQL (bcrypt) |
| Sesión | `express-session` almacenada en tabla `session` de PostgreSQL — persiste entre reinicios |
| Roles | `admin`, `docente` |
| Admin por defecto | email `admin@plandocente.com` / pass `admin123` (creado en DB al iniciar) |
| Login como admin | Redirige automáticamente al panel de administración |
| Login como docente | Redirige a planificaciones |

### Tabla `usuarios` (PostgreSQL)
```sql
id SERIAL PRIMARY KEY, nombre VARCHAR(200), email VARCHAR(200) UNIQUE,
password_hash VARCHAR(255), rol VARCHAR(20), estado VARCHAR(20), fecha_alta DATE
```

### API REST (`server.js`)
| Endpoint | Método | Auth | Descripción |
|---|---|---|---|
| `/api/me` | GET | — | Sesión actual |
| `/api/login` | POST | — | Iniciar sesión |
| `/api/logout` | POST | auth | Cerrar sesión |
| `/api/usuarios` | GET | admin | Listar usuarios |
| `/api/usuarios` | POST | admin | Crear usuario |
| `/api/usuarios/:id/estado` | PUT | admin | Toggle activo/inactivo |
| `/api/usuarios/:id/rol` | PUT | admin | Cambiar rol |
| `/api/usuarios/:id/password` | PUT | admin | Resetear contraseña |
| `/api/me/password` | PUT | auth | Cambiar propia contraseña |
| `/api/usuarios/:id` | DELETE | admin | Eliminar usuario |

### Funciones clave de auth en `index.html`
| Función | Descripción |
|---|---|
| `_getSesion()` | Devuelve `_sesionActual` (variable en memoria, cargada desde `/api/me`) |
| `loginUsuario()` | POST /api/login → actualiza `_sesionActual`, oculta pantalla de acceso |
| `logoutUsuario()` | POST /api/logout → limpia sesión, muestra pantalla de acceso |
| `_aplicarSesion()` | Pone nombre en topbar, muestra/oculta tab admin |
| `registrarUsuario()` | POST /api/usuarios (solo admin) |
| `cambiarPassword()` | PUT /api/me/password |
| `renderAdminUsuarios()` | GET /api/usuarios → renderiza tabla |
| `adminToggleEstado()` | PUT /api/usuarios/:id/estado |
| `adminCambiarRol()` | PUT /api/usuarios/:id/rol |
| `adminResetPassword()` | PUT /api/usuarios/:id/password |
| `adminIniciarBaja()` | DELETE /api/usuarios/:id |

### Privacidad por usuario
- `guardarPlanificacion()` estampa `usuarioId` al crear.
- `renderPlanificaciones()` filtra por `sesion.id`; superadmin ve todas.
- `guardarInforme()` estampa `usuarioId` al crear.
- `renderInformesGuardados()` filtra por `sesion.id`; superadmin ve todos.

## Estructura de la app

### Navegación (orden de tabs)
Sistema de páginas tipo SPA con tabs sticky. `mostrarPagina(id)` activa la página y el tab correspondiente.

| Orden | Tab | ID de página |
|---|---|---|
| 1 | 🏫 Escuelas y Cursos | `pagina-cursos` |
| 2 | 👥 Alumnos | `pagina-alumnos` |
| 3 | 📘 Planificaciones (default) | `pagina-planificaciones` |
| 4 | 📝 Registro de clase | `pagina-registros` |
| 5 | 📋 Informes | `pagina-informes` |
| 6 | 🕐 Actividad reciente | `pagina-actividad` |
| 7 | ⚙️ Administración | `pagina-admin` (solo superadmin) |

### Páginas y funcionalidades

**Asistente Rápido (en pagina-planificaciones, encima del formulario):**
- Input de texto libre: el docente escribe una frase ("vocales para 1° grado", "texto narrativo para 2° año secundaria")
- Parser `_parsearConsulta()` extrae: grado (1°-6° primaria o 1°-6° secundaria), materia (inferida de keywords), tema
- Genera automáticamente: planificación de clase (inicio/desarrollo/cierre/evaluación) + 5 fichas progresivas
- Progresión de fichas: Reconocimiento → Identificación → Práctica guiada → Aplicación → Producción propia
- Sistema de 4 niveles de contenido según `gradoNum` en `_infoTema()`:
  - n=1 (grado 1-2): actividades orales, visuales, concretas; lenguaje muy simple
  - n=2 (grado 3-4): análisis guiado, escritura breve, clasificaciones con apoyo
  - n=3 (grado 5-6): argumentativo, análisis crítico, producción compleja
  - n=4 (secundaria, gradoNum 7+): académico; análisis de fuentes, ensayo, demostración, debate
- 20+ temas con contenido específico por nivel, más fallbacks por clasificación de concepto
- Fallbacks clasifican el tema en 10 subcategorías pedagógicas (verbos, sintaxis, texto/comprensión, ortografía, operaciones, geometría, estadística, álgebra, ciencias biológicas, historia, geografía) y generan contenido basado en el TIPO de concepto, no repitiendo su nombre como placeholder
- Chips de ejemplo separados: sección Primaria y sección Secundaria
- Funciones JS: `usarEjemplo()`, `_parsearConsulta()`, `_actividadesEtapa()`, `_buildAsistentePlan()`, `_buildAsistenteFicha()`, `generarAsistente()`, `imprimirAsistente()`
- Helpers: `_lin()` (renglones), `_tab()` (tablas), `_box()` (cajas de dibujo), `_palabras()` (recuadros de palabras)
- Output en `#resultado-asistente` (en misma pagina-planificaciones)

**Planificaciones:**
- Genera secuencias didácticas de 10 clases (11+ temas con contenido curricular específico)
- Al generar: aparece panel "Guardar como borrador / Guardar como final"
- Historial filtrable por curso, con acciones: Abrir, Duplicar, Eliminar
- Planificación abierta se carga de vuelta en el editor

**Escuelas y Cursos:** CRUD de escuelas (con nivel) y cursos por escuela. Cascade delete.

**Alumnos:** CRUD de alumnos por curso. Ordenados por apellido.

**Registro de clase:**
- Nuevo registro con fecha, título, descripción y vinculación opcional a una planificación
- Historial editable in-place (botón Editar → form → Guardar cambios)
- Eliminar con confirmación

**Informes:**
- Generador automático de borradores a partir de registros de clase
- Editor de texto editable (textarea) para personalizar el informe
- Guardar como borrador o final
- Descargar PDF, Copiar texto
- Historial de informes guardados filtrable por alumno
- Acciones: Abrir, Duplicar, Eliminar

**Actividad reciente:**
- Vista unificada de planificaciones + registros + informes
- Ordenados por fecha de modificación descendente (máx. 50 items)
- Filtros: por tipo y por curso
- Chips de color por tipo: 📘 azul / 📝 rosa / 📋 violeta
- Botón Abrir para planificaciones e informes

**Fichas para alumnos (`pagina-fichas`):**
- Formulario: grado, materia, tema, nivel del grupo (básico/intermedio/avanzado), indicaciones del docente (opcional)
- Genera hoja de trabajo imprimible con 7-8 actividades variadas con contenido real (palabras, ejemplos, números concretos)
- Progresión pedagógica: reconocimiento → comprensión → aplicación → producción
- **Matemática**: cálculos completos con números reales, problemas contextualizados, V/F con operaciones, opción múltiple, unir operación↔resultado
- **Lengua** (temas específicos): sustantivos, adjetivos, verbos, texto narrativo, poema, comprensión, oración, mayúsculas, ortografía, texto expositivo, argumentativo, sílabas — cada uno con contenido de ese tema
- **Ciencias Naturales / Sociales**: handlers específicos por tema:
  - Animales, Plantas, Cuerpo Humano, Sistema Solar (con vocab y V/F reales)
  - Ecosistemas (cadena alimentaria, productores/consumidores/descomponedores)
  - Historia Argentina (próceres, fechas, revolución, independencia)
  - Geografía/Relieve (Andes, llanura pampeana, regiones)
  - Célula (membrana, citoplasma, núcleo, mitocondria)
  - Materia y estados (fusión, vaporización, solidificación)
  - Sociedad y democracia (derechos, deberes, ciudadanía)
  - Fallback genérico con vocab de Ciencias reales (no placeholders)
- **Química/Física** (secundaria): átomo, mezclas, reacciones, enlaces, materia/energía, cinemática, dinámica, óptica, termodinámica, electricidad
- Sin tablas "Categoría A/B" ni vocab vacío — cada tema tiene contenido propio
- `_actividadesEtapa(etapa, tema, materia, gradoNum, esPrimerCiclo)` — función central de generación por etapa pedagógica (1-5)
- Funciones JS clave: `generarFichaAlumno()`, `_buildFichaHTML()`, `_buildAsistenteFicha()`, `_actividadesEtapa()`
- Helpers: `_tab()`, `_fVFtabla()`, `_fMultiple()`, `_fUnir()`, `_fOrdenar()`, `_fRecuadro()`, `_fGrid()`, `_fLineas()`, `_palabras()`, `_box()`

**Administración (superadmin):**
- Tabla completa de usuarios con columnas: Nombre, Email, Rol, Estado, Fecha de alta, Acciones
- Crear nuevo docente (desde topbar o panel)
- Activar/desactivar, cambiar rol, restablecer contraseña, eliminar usuario

### LocalStorage keys
| Key | Contenido |
|---|---|
| `pd_usuarios` | `{ id, nombre, email, password, rol, estado, fechaAlta }` |
| `pdi_escuelas` | `{ id, nombre, nivel }` |
| `pdi_cursos` | `{ id, escuelaId, nombre, turno }` |
| `pdi_alumnos` | `{ id, cursoId, nombre, apellido }` |
| `pdi_registros` | `{ id, cursoId, cursoNombre, escuelaNombre, fecha, titulo, descripcion, planifId, estado, fechaCreacion, fechaMod }` |
| `pdi_planificaciones` | `{ id, usuarioId, cursoId, cursoNombre, escuelaNombre, materia, grado, tema, titulo, contenidoHTML, estado, fechaCreacion, fechaMod }` |
| `pdi_informes` | `{ id, usuarioId, alumnoId, cursoId, alumnoNombre, cursoNombre, contenido, estado, fechaCreacion, fechaMod }` |

### UI Components
- Toast notification (`#toast`) — aparece 2.8s, esquina inferior centrada
- Badges de estado: `estado-borrador` (amarillo) / `estado-final` (verde)
- `hist-card` — tarjeta de historial con header, meta y acciones
- `chip-tipo` — chip de color según tipo de contenido
- `pd-admin-table` — tabla de usuarios con hover
- `badge-activo / badge-inactivo / badge-sa` — badges de estado/rol de usuario
- `pd-modal-bg / pd-modal` — sistema modal genérico con clase `abierto`
- `pd-modal-msg` — mensajes de resultado en modales (clases: error, ok, info)

## Servidor
Static Web Server en puerto 80, archivos desde `./`, entrada `index.html`
