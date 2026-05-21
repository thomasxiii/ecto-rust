//! Smoke-test source — the same starter the TS playground ships, so
//! the Rust pipeline and TS pipeline can be diffed on the same input.

pub const STARTER_ECTOSCRIPT: &str = r#"// A task app built from EctoScript primitives.
//
// New cognitive ability:  match X in Y by Z
//   On the All Tasks view, submitted tasks are routed to the best-fit
//   project by an AI call to /api/cognition/match (Claude). The task
//   appears immediately with no project label; the label fills in
//   when the call resolves.
//
// New collection primitives:
//   state X = []                     — list-valued state
//   add to <atom>                    — push a record to a list atom
//   clear <atom>                     — reset an atom to its empty value
//   query Name = <list> [where ...]  — derived/filtered collection
//   < for X in <list-or-query>       — render children per item

// ── Data models ─────────────────────────────────────────────────────
model ProjectModel
  state projects = []

model TaskModel
  state tasks = []

model App
  state view = "all"
  state selectedProjectId = null

model Theme
  state darkMode = false

// ── Derived collections ─────────────────────────────────────────────
query AllTasks = TaskModel.tasks

query CurrentTasks = TaskModel.tasks
  where projectId is App.selectedProjectId

// ── Forms ───────────────────────────────────────────────────────────
component NewProjectForm
  state name = ""

  render
    < row
      style InputRow
      < input
        placeholder: "New project name..."
        value binds NewProjectForm.name
        on submit
          add to ProjectModel.projects
            name: NewProjectForm.name
          clear NewProjectForm.name
      < button
        text: "Add"
        style PrimaryButton
        on click
          add to ProjectModel.projects
            name: NewProjectForm.name
          clear NewProjectForm.name

component SmartTaskForm
  // All Tasks view: classify the new task into a project via match().
  state text = ""

  render
    < row
      style InputRow
      < input
        placeholder: "Add a task (will pick a project)..."
        value binds SmartTaskForm.text
        on submit
          add to TaskModel.tasks
            text: SmartTaskForm.text
            done: false
            expanded: false
            description: ""
            projectId: match SmartTaskForm.text in ProjectModel.projects by name
          clear SmartTaskForm.text
      < button
        text: "Add"
        style PrimaryButton
        on click
          add to TaskModel.tasks
            text: SmartTaskForm.text
            done: false
            expanded: false
            description: ""
            projectId: match SmartTaskForm.text in ProjectModel.projects by name
          clear SmartTaskForm.text

component ManualTaskForm
  // Project view: project is already selected, no match needed.
  state text = ""

  render
    < row
      style InputRow
      < input
        placeholder: "Add a task to this project..."
        value binds ManualTaskForm.text
        on submit
          add to TaskModel.tasks
            text: ManualTaskForm.text
            done: false
            expanded: false
            description: ""
            projectId: App.selectedProjectId
          clear ManualTaskForm.text
      < button
        text: "Add"
        style PrimaryButton
        on click
          add to TaskModel.tasks
            text: ManualTaskForm.text
            done: false
            expanded: false
            description: ""
            projectId: App.selectedProjectId
          clear ManualTaskForm.text

// ── Task card ───────────────────────────────────────────────────────
// Reads from the "task" scope variable provided by the enclosing
// "< for task in ... >" loop. Double-click toggles expansion; the
// description and project label use the same scope.

query TaskProject = ProjectModel.projects
  where id is task.projectId

component Task
  render
    < container
      style TaskCard
      on doubleclick
        toggle task.expanded

      < row
        style TaskHeader

        < checkbox
          checked binds task.done

        < container
          style TaskBody

          < heading binds task.text

          < for project in TaskProject
            < subheading
              style ProjectLabel
              text binds project.name

      < container when task.expanded
        style TaskDescription
        < description
          is editable
          text binds task.description

// ── Root ────────────────────────────────────────────────────────────
component App
  render
    < row
      style Page

      // Sidebar — All Tasks + project list + new-project form.
      < container
        style Sidebar
        < heading
          text: "Projects"
        < container
          style SidebarItem
          on click
            set App.view = "all"
            set App.selectedProjectId = null
          < text
            text: "All Tasks"
        < for project in ProjectModel.projects
          < container
            style SidebarItem
            on click
              set App.view = "project"
              set App.selectedProjectId = project.id
            < text binds project.name
        < NewProjectForm

      // Main content.
      < container
        style Main

        < container when App.view is "all"
          < heading
            text: "All Tasks"
          < SmartTaskForm
          < for task in AllTasks
            < Task

        < container when App.view is "project"
          < heading
            text: "Project Tasks"
          < ManualTaskForm
          < for task in CurrentTasks
            < Task

// ── Theme tokens ────────────────────────────────────────────────────
token Radius = 12px
token White = #ffffff
token Black = #111111
token Blue = #4f7cff
token Grey = #f1f5f9
token Slate = #e2e8f0

derived Bg = if Theme.darkMode Black or White
derived Fg = if Theme.darkMode White or Black
derived SidebarBg = if Theme.darkMode Black or Grey

// ── Styles ──────────────────────────────────────────────────────────
styles Page
  flexDirection: row
  width: 100%
  height: 100%
  gap: 0

styles Sidebar
  width: 240px
  bg: SidebarBg
  fg: Fg
  padding: 16px
  gap: 4px

styles Main
  flex: 1
  padding: 24px
  gap: 12px

styles SidebarItem
  padding: 8px 12px
  radius: 6px
  fg: Fg

styles TaskCard
  bg: Bg
  fg: Fg
  radius: Radius
  shadow: 0 2px 8px Black.10
  padding: 12px 16px
  border: 1px solid Slate
  gap: 6px

styles TaskHeader
  flexDirection: row
  gap: 10px

styles TaskBody
  flex: 1
  gap: 2px

styles TaskDescription
  padding: 6px 0 0 28px
  gap: 4px

styles ProjectLabel
  fg: #94a3b8
  fontSize: 11px

styles InputRow
  flexDirection: row
  gap: 8px

styles PrimaryButton
  bg: Blue
  fg: White
  radius: 8px
  padding: 8px 14px
"#;
