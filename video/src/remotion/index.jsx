import React from 'react'
import { Composition, registerRoot } from 'remotion'
import { YearWrap } from './YearWrap.jsx'
import defaultStoryline from './default-storyline.json'

// One composition for every segment: the storyline carries its segment, and
// the segment picks the theme. Duration comes from the storyline because
// scenes are dropped when a child skipped questions.
function Root() {
  return (
    <Composition
      id="YearWrap"
      component={YearWrap}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={defaultStoryline.durationInFrames}
      defaultProps={{ storyline: defaultStoryline }}
      calculateMetadata={({ props }) => ({ durationInFrames: props.storyline.durationInFrames })}
    />
  )
}

registerRoot(Root)
