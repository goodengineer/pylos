const R = require('ramda')
const { createStore } = require('redux')

const { colors: { BALL_PLAYER_1, BALL_PLAYER_2 } } = require('../../constants')
const { mapF, getInterval } = require('../../functional')
const { createBoard, ballsLeft, isGameOver } = require('../../pylos')
const { drawBoard } = require('../../render')
const { getWindowSize, getQueryParameter} = require('../../browser')
const { pylosReducer, uiReducer } = require('./reducers')
const {
  pylos: {
    insertAction,
    liftAction,
    removeAction,
    commitAction,
    overrideStateAction,
    overrideHistoryAction
  },
  ui: {
    selectAction,
    unselectAction,
    allowRemovalsAction,
    disallowRemovalsAction,
    changeSizeAction
  }
} = require('./actions')
const { connectToGame, pushAction } = require('../../firebase')
const { getCanvas, getCanvasContainer, getInfoPanel, sizeToUiValues } = require('./ui')

const { canvasClickListener } = require('./listeners')
const { toLocalActions } = require('./converters')

const App = (() => {

  let canvas
  let canvasContainer
  let infoPanel
  let game_id
  let player

  let pylosStore = createStore(pylosReducer, {
    board: createBoard(),
    turn: 1,
    history: []
  })

  const uiStore = createStore(uiReducer, {
    size: 800,
    history: []
  })

  function start() {
    console.log('app running')
    handleParameters()
    canvas = getCanvas()
    canvasContainer = getCanvasContainer()
    infoPanel = getInfoPanel()

    window.addEventListener('resize', () => {
      updateCanvas()
      render()
    })

    updateCanvas()
    render()

    setListeners()
  }

  function handleParameters() {
      game_id = getQueryParameter('game_id')
      player = parseInt(getQueryParameter('player'), 10)

      if (!game_id) {
          throw new Error('game_id is missing')
      }
      if (player !== 1 && player !== 2) {
          throw new Error('player is missing');
      }

      connectToGame (handleStateUpdate) (game_id)
  }

  const filterValidActions = actions => {
    const validActions = []
    const store = createStore(pylosReducer, {
      board: createBoard(),
      turn: 1,
      history: []
    })

    actions.forEach(action => {
      if (isValidAction(store.getState(), action)) {
        store.dispatch(action)
        validActions.push(action)
      }
    })

    return validActions
  }

  const reduceActions = actions => {
    const store = createStore(pylosReducer, {
      board: createBoard(),
      turn: 1,
      history: []
    })
    actions.forEach(store.dispatch)
    return store.getState()
  }

  const overridePylosHistory = pylosStore => actions => {
    const resultingState = reduceActions(actions)
    pylosStore.dispatch(overrideStateAction(resultingState))
    pylosStore.dispatch(overrideHistoryAction(actions))
    return actions
  }

  const handleStateUpdate = pylosStore => R.pipe(
    R.tap(x => {
      console.log(x);
    }),
    R.chain(toLocalActions),
    filterValidActions,
    R.when(actions => !R.equals(actions, pylosStore.getState().history), R.pipe(overridePylosHistory(pylosStore), render))
  )

  const isType = expectedType => ({ actualType }) => expectedType === actualType

  const getCheckpoints = R.pipe(
    R.map((action, i) => ({ ...action, i })),
    R.filter(isType ('COMMIT')) // TODO: replace with constant
  )

  const getLastCheckpointInterval = checkpoints => {
    const fromIndex = checkpoints.length === 1 ? 1 : checkpoints[checkpoints.length - 2].i + 1
    const toIndex = checkpoints[checkpoints.length - 1].i - 1
    return [fromIndex, toIndex]
  }

  const getLastCheckpointActions = history => R.pipe(
    getCheckpoints,
    getLastCheckpointInterval,
    R.flip(getInterval) (history)
  )(history)

  // function afterCommit() {
  //     const { history } = pylosStore.getState()
  //     const checkpoints = history.map((action, i) => ({...action, i})).filter(({type}) => type === 'COMMIT')
  //     const fromIndex = checkpoints.length === 1 ? 1 : checkpoints[checkpoints.length - 2].i + 1
  //     const toIndex = checkpoints[checkpoints.length - 1].i - 1
  //     const [mainAction, ...removalActions] = history.filter((_, i) => fromIndex <= i && i <= toIndex)
  //     const removals = removalActions ? removalActions.map(R.prop('position')) : []
  //     const { type } = mainAction
  //
  //     console.log({history, fromIndex, toIndex});
  //     if (type === 'INSERT') {
  //         const { position, player } = mainAction
  //         insertMove (position, player, removals) (game_id)
  //     } else if (type === 'LIFT') {
  //         const { from, to } = mainAction
  //         liftMove (from, to, removals) (game_id)
  //     } else {
  //         console.error(`invalid type ${type}`);
  //     }
  // }

  const calculateNewSize = ({ width, height }) => width < 560 ? 0.7*width : 0.5*height

  const getNewSize = R.pipe(
      getWindowSize,
      calculateNewSize
  )

  function updateCanvas() {
    const newSize = getNewSize()

    uiStore.dispatch(changeSizeAction(newSize))
    canvas.width = newSize
    canvas.height = newSize
    infoPanel.style.width = `${newSize}px`
    infoPanel.style.height = `${newSize/2.5}px`
  }

  const getState = store => store.getState()

  const uiStoreToSize = R.pipe(
      getState,
      R.prop('size')
  )

  const uiStoreToUiValues = R.pipe(
      uiStoreToSize,
      sizeToUiValues
  )

  function setListeners() {

    canvas.addEventListener('click', R.pipe(
      canvasClickListener (pylosStore, uiStore),
      checkpointValidation
    ))

    document.getElementById('confirm-button').addEventListener('click', () => {
        pylosStore.dispatch(commitAction())
        uiStore.dispatch(disallowRemovalsAction())
        checkpointValidation()
    })

    pylosStore.subscribe(() => render())
    uiStore.subscribe(() => render())
  }

  // TODO: DECIDE WHEN TO CALL THIS FUNCTION
  function checkpointValidation() {
    const { turn, history } = pylosStore.getState()
    const { type } = R.last(history)
    if (type === 'COMMIT' && turn === player) {
      return R.pipe(
        getLastCheckpointActions,
        toFirebaseAction,
        pushAction(game_id)
      ) (history)
    }
  }

  function render() {
    const { unit } = uiStoreToUiValues(uiStore)
    const { board, turn } = pylosStore.getState()
    const { canRemove } = uiStore.getState()
    const elementList = document.querySelectorAll('#info-panel .ball-info .ball');
    elementList.forEach(el => {
        el.style.width = `${unit}px`
        el.style.height = `${unit}px`
    })

    const leftPanel = document.querySelector('#info-panel .ball-info.left')
    const rightPanel = document.querySelector('#info-panel .ball-info.right')
    const ballsLeft1 = ballsLeft(board, 1)
    const ballsLeft2 = ballsLeft(board, 2)
    leftPanel.querySelector('#info-panel .ball-info.left .number').innerHTML = `${ballsLeft1}`
    rightPanel.querySelector('#info-panel .ball-info.right .number').innerHTML = `${ballsLeft2}`

    leftPanel.querySelector('.ball').style.background = BALL_PLAYER_1;
    rightPanel.querySelector('.ball').style.background = BALL_PLAYER_2;

    const leftNote = leftPanel.querySelector('.note')
    const rightNote = rightPanel.querySelector('.note')

    if (player === 1) {
        leftNote.innerHTML = 'you'
        rightNote.innerHTML = 'opponent'
    } else {
        leftNote.innerHTML = 'opponent'
        rightNote.innerHTML = 'you'
    }

    leftPanel.classList.remove('turn')
    rightPanel.classList.remove('turn')
    if (turn === 1) {
        leftPanel.classList.add('turn')
    } else {
        rightPanel.classList.add('turn')
    }

    if (canRemove) {
        document.getElementById('confirm-button').style.visibility = 'visible'
    } else {
        document.getElementById('confirm-button').style.visibility = 'hidden'
    }

    drawBoard(uiStoreToUiValues(uiStore))(pylosStore.getState(), uiStore.getState())(canvas)

    if (isGameOver(board)) {
        const gameOverEl = document.getElementById('game-over-message')
        let message
        if (ballsLeft(board, player) <= 0) {
            message = 'DEFEAT'
        } else {
            message = 'VICTORY'
        }

        gameOverEl.innerHTML = message
        gameOverEl.style.visibility = 'visible'
    }
  }

  return {
    start
  }
})()

window.addEventListener('load', () => {
  App.start()
})
