import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GameEngine } from 'react-game-engine';
import { ArrowLeft, ArrowRight, ArrowUp, SkipForward } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { HERO_NAME, levelDialogues } from '../data/scriptDialogue';
import { levels } from '../game/levels';
import { WorldSprite } from '../game/WorldSprite';
import { gameSystems } from '../game/systems';
import type { GameEvent, GameStatus } from '../game/types';
import { useGameAudio } from '../hooks/useGameAudio';
import { useGameContext } from '../context/GameContext';
import { ApiError, createScore, GAME_NAME } from '../services/api';
import { validatePlayerName } from '../utils/scoreValidation';
import './GamePage.css';

type SubmitState = 'idle' | 'saving' | 'saved' | 'error';

const formatTime = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
};

const dialogueFor = (levelIndex: number) => levelDialogues[levelIndex + 1] ?? [];

export const GamePage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // `?level=3` : entrée directe depuis le Dev Mode.
  const requested = Number(searchParams.get('level'));
  const devStart = Number.isInteger(requested) && requested >= 1 && requested <= levels.length;
  const startIndex = devStart ? requested - 1 : 0;

  const [status, setStatus] = useState<GameStatus>(dialogueFor(startIndex).length > 0 ? 'intro' : 'playing');
  const [runId, setRunId] = useState(0);
  const [introIndex, setIntroIndex] = useState(0);
  const [levelIndex, setLevelIndex] = useState(startIndex);
  const [coins, setCoins] = useState(0);
  const [clearedLevels, setClearedLevels] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [playerNameTouched, setPlayerNameTouched] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const isLastLevel = levelIndex >= levels.length - 1;
  const { state: gameState, dispatch } = useGameContext();
  const playerName = gameState.playerName;
  const playerNameError = validatePlayerName(playerName);

  // La durée envoyée à l'API doit être lisible hors du cycle de rendu.
  const elapsedRef = useRef(0);
  // Le moteur dispatche encore quelques ticks avant de s'arrêter : on filtre les doublons.
  const statusRef = useRef<GameStatus>('intro');

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (status !== 'playing') return;
    const origin = Date.now() - elapsedRef.current;
    const intervalId = window.setInterval(() => {
      elapsedRef.current = Date.now() - origin;
      setElapsedMs(elapsedRef.current);
    }, 100);
    return () => window.clearInterval(intervalId);
  }, [status]);

  const dialogue = dialogueFor(levelIndex);
  const line = dialogue[introIndex] ?? dialogue[dialogue.length - 1];
  const speaker = typeof line === 'object' ? line.speaker : HERO_NAME;
  const spokenText = (typeof line === 'object' ? line.text : line) ?? '';
  const {
    loseSoundRef,
    loseSoundSource,
    musicRef,
    musicSource,
    playDialogueClick,
    revealDialogue,
    startMusic,
    visibleChars,
  } = useGameAudio({
    status,
    isBossLevel: isLastLevel,
    spokenText,
    isVillain: speaker !== HERO_NAME,
  });

  const advanceIntro = useCallback(() => {
    if (visibleChars < spokenText.length) {
      revealDialogue();
      return;
    }
    playDialogueClick(speaker !== HERO_NAME);
    const nextIndex = introIndex + 1;
    if (nextIndex >= dialogue.length) {
      setIntroIndex(0);
      setStatus('playing');
      startMusic();
      return;
    }
    setIntroIndex(nextIndex);
  }, [dialogue.length, introIndex, playDialogueClick, revealDialogue, speaker, spokenText.length, startMusic, visibleChars]);

  const skipIntro = useCallback(() => {
    setIntroIndex(0);
    setStatus('playing');
    startMusic();
  }, [startMusic]);

  /** Niveau suivant : les pièces et le chrono sont conservés, le dialogue remet le jeu en pause. */
  const nextLevel = useCallback(() => {
    const next = levelIndex + 1;
    setLevelIndex(next);
    setIntroIndex(0);
    setStatus(dialogueFor(next).length > 0 ? 'intro' : 'playing');
    setRunId((run) => run + 1);
  }, [levelIndex]);

  /** Nouvelle partie : tous les compteurs repartent de zéro. */
  const newGame = useCallback(() => {
    elapsedRef.current = 0;
    setElapsedMs(0);
    setCoins(0);
    setClearedLevels(0);
    setLevelIndex(startIndex);
    setSubmitState('idle');
    setSubmitError(null);
    setIntroIndex(0);
    setStatus(dialogueFor(startIndex).length > 0 ? 'intro' : 'playing');
    setRunId((run) => run + 1);
  }, [startIndex]);

  const handleEvent = useCallback((event: GameEvent) => {
    if (statusRef.current !== 'playing') return;
    if (event.type === 'coin') setCoins((current) => current + 1);
    if (event.type === 'win') {
      statusRef.current = 'won';
      setClearedLevels((current) => current + 1);
      setStatus('won');
    }
    if (event.type === 'lose') {
      statusRef.current = 'lost';
      setStatus('lost');
    }
  }, []);

  const submitScore = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setPlayerNameTouched(true);
      if (playerNameError) return;
      setSubmitState('saving');
      setSubmitError(null);
      try {
        const score = await createScore({
          player: playerName.trim(),
          game: GAME_NAME,
          coins,
          levels: clearedLevels,
          durationMs: elapsedRef.current,
        });
        dispatch({ type: 'scoreSaved', score });
        setSubmitState('saved');
      } catch (error) {
        setSubmitError(
          error instanceof ApiError
            ? (error.fields[0]?.message ?? error.message)
            : 'Erreur inattendue pendant l’enregistrement.',
        );
        setSubmitState('error');
      }
    },
    [clearedLevels, coins, dispatch, playerName, playerNameError],
  );

  useEffect(() => {
    if (status !== 'intro' && (status !== 'won' || isLastLevel)) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (status === 'intro') advanceIntro();
      else nextLevel();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [advanceIntro, isLastLevel, nextLevel, status]);

  const focusEngine = (event: MouseEvent<HTMLDivElement>) => {
    if (status === 'playing') startMusic();
    event.currentTarget.querySelector<HTMLElement>('.platformer-engine')?.focus();
  };

  const recap = `${coins} pièces · ${clearedLevels} niveau(x) · ${formatTime(elapsedMs)}`;

  const scoreForm =
    submitState === 'saved' ? (
      <>
        <p className="platformer-recap">Score enregistré pour {playerName.trim()}.</p>
        <div className="platformer-actions">
          <Button onClick={() => navigate('/leaderboard')}>VOIR LE CLASSEMENT</Button>
          <Button variant="secondary" onClick={newGame}>REJOUER</Button>
        </div>
      </>
    ) : (
      <form className="platformer-form" onSubmit={submitScore}>
        <label htmlFor="player-name">Entrez votre nom</label>
        <input
          id="player-name"
          name="player"
          autoFocus
          maxLength={20}
          value={playerName}
          onChange={(event) => dispatch({ type: 'setPlayerName', playerName: event.target.value })}
          onBlur={() => setPlayerNameTouched(true)}
          aria-invalid={playerNameTouched && Boolean(playerNameError)}
          aria-describedby={playerNameTouched && playerNameError ? 'player-name-error' : undefined}
          placeholder="Votre pseudo"
        />
        {playerNameTouched && playerNameError && <p id="player-name-error" className="platformer-error">{playerNameError}</p>}
        {submitError && <p role="alert" className="platformer-error">{submitError}</p>}
        <div className="platformer-actions">
          <Button type="submit" disabled={submitState === 'saving' || Boolean(playerNameError)}>
            {submitState === 'saving' ? 'ENVOI…' : 'ENREGISTRER'}
          </Button>
          <Button type="button" variant="secondary" onClick={newGame}>REJOUER</Button>
        </div>
      </form>
    );

  return (
    <section className="platformer-shell">
      <audio ref={musicRef} src={musicSource} loop preload="auto" />
      <audio ref={loseSoundRef} src={loseSoundSource} preload="auto" />
      <div className="platformer-hud">
        <span className="hud-item"><b>PIÈCES</b> {coins}</span>
        <span className="hud-item"><b>NIVEAU</b> {levelIndex + 1}/{levels.length}</span>
        <span className="hud-item"><b>TEMPS</b> {formatTime(elapsedMs)}</span>
      </div>

      <div className="platformer-stage" onClick={focusEngine} aria-label="Platformer game. Use arrow keys or Q and D to move, and Up, Z, or Space to jump. Reach the door on the right to finish the level.">
        <GameEngine className="platformer-engine" key={runId} systems={gameSystems} entities={{ world: { ...levels[levelIndex]!.build(), renderer: WorldSprite } }} onEvent={handleEvent} running={status === 'playing'}>
          <div className="touch-controls" aria-label="Commandes tactiles">
            <div className="touch-controls-movement">
              <button type="button" className="game-button touch-control" data-game-key="arrowleft" aria-label="Aller à gauche" title="Aller à gauche">
                <ArrowLeft aria-hidden="true" />
              </button>
              <button type="button" className="game-button touch-control" data-game-key="arrowright" aria-label="Aller à droite" title="Aller à droite">
                <ArrowRight aria-hidden="true" />
              </button>
            </div>
            <button type="button" className="game-button touch-control touch-control-jump" data-game-key="z" aria-label="Sauter" title="Sauter">
              <ArrowUp aria-hidden="true" />
            </button>
          </div>
        </GameEngine>

        {status === 'intro' && (
          <div className="platformer-overlay platformer-intro" aria-live="polite">
            <div className="dialogue-box" data-villain={speaker !== HERO_NAME} role="dialog" aria-label="Intro dialogue" onClick={advanceIntro}>
              <p className="dialogue-name">{speaker}</p>
              <p>{spokenText.slice(0, visibleChars)}</p>
              <div className="dialogue-actions">
                <span className="dialogue-hint">Entrée pour continuer</span>
                <Button
                  type="button"
                  className="dialogue-skip"
                  aria-label="Passer tous les dialogues"
                  onClick={(event) => {
                    event.stopPropagation();
                    skipIntro();
                  }}
                >
                  <SkipForward aria-hidden="true" size={18} />
                  Passer
                </Button>
              </div>
            </div>
          </div>
        )}

        {status === 'won' && !isLastLevel && (
          <div className="platformer-overlay">
            <p>LEVEL CLEAR</p>
            <p className="platformer-recap">{recap}</p>
            <Button onClick={nextLevel}>NEXT LEVEL</Button>
          </div>
        )}

        {status === 'won' && isLastLevel && (
          <div className="platformer-overlay">
            <p>VICTOIRE</p>
            <p className="platformer-recap">{recap}</p>
            {scoreForm}
          </div>
        )}

        {status === 'lost' && (
          <div className="platformer-overlay">
            <p>GAME OVER</p>
            <p className="platformer-recap">{recap}</p>
            {scoreForm}
          </div>
        )}
      </div>

      <Button variant="danger" onClick={() => navigate('/')}>BACK TO MENU</Button>
    </section>
  );
};